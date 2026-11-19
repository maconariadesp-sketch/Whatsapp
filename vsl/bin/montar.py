#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Motor de montagem de VSL — texto -> video pronto.

Nao depende de nenhuma biblioteca externa: so Python 3 + ffmpeg.
Roda igual no Linux, Mac e Windows (com ffmpeg no PATH).

Uso:
    python3 vsl/bin/montar.py vsl/roteiro.exemplo.json
    python3 vsl/bin/montar.py meu-roteiro.json --formato 9:16
    python3 vsl/bin/montar.py meu-roteiro.json --formato todos
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------- constantes

FORMATOS = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1":  (1080, 1080),
    "4:5":  (1080, 1350),
}

FPS = 30
# Velocidade media de locucao em portugues, em palavras por segundo.
# Usada so quando a cena nao tem audio de narracao ainda (modo rascunho).
PPS_PT = 2.6

FONTES_CANDIDATAS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


# ---------------------------------------------------------------- utilidades

def morrer(msg):
    print("\n[ERRO] %s\n" % msg, file=sys.stderr)
    sys.exit(1)


def rodar(cmd, stderr=False):
    """Executa um comando e devolve stdout (ou stderr, se pedido).
    Levanta erro com a cauda do log do ffmpeg."""
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        cauda = (res.stderr or "").strip().splitlines()[-25:]
        raise RuntimeError(
            "comando falhou:\n  %s\n\n%s" % (" ".join(cmd), "\n".join(cauda))
        )
    return res.stderr if stderr else res.stdout


def niveis_do_audio(caminho_audio):
    """Devolve (piso_de_ruido_dB, rms_dB) do arquivo."""
    try:
        log = rodar(["ffmpeg", "-hide_banner", "-nostats", "-i", caminho_audio,
                     "-af", "astats=metadata=1:reset=0", "-f", "null", "-"],
                    stderr=True)
    except RuntimeError:
        return (None, None)
    def pegar(rotulo):
        # astats escreve "-inf" em silencio digital puro
        m = re.findall(r"%s:\s*(-?inf|-?[\d.]+)" % rotulo, log)
        if not m:
            return None
        try:
            v = float(m[0])
        except ValueError:
            return None
        return -90.0 if v == float("-inf") else (None if v != v else v)
    return (pegar("Noise floor dB"), pegar("RMS level dB"))


def segmentos_de_fala(caminho_audio, duracao, pausa_min=0.22):
    """Descobre onde ha fala no audio, via deteccao de silencio do ffmpeg.

    O limiar e ADAPTATIVO: um valor fixo nao serve porque depende do quanto
    o microfone captou de ruido de sala. Fica acima do piso de ruido do
    proprio arquivo e abaixo do nivel medio da voz.

    Devolve [(inicio, fim), ...]. Se a deteccao nao produzir um resultado
    confiavel, devolve o trecho inteiro, e quem chama volta a dividir o
    tempo por igual.
    """
    piso, rms = niveis_do_audio(caminho_audio)
    if piso is None or rms is None or rms <= piso:
        limiar_db = -34
    else:
        # acima do ruido de sala, mas bem abaixo da voz
        limiar_db = max(piso + 5.0, rms - 12.0)
        limiar_db = min(limiar_db, rms - 3.0)

    try:
        log = rodar(["ffmpeg", "-hide_banner", "-nostats", "-i", caminho_audio,
                     "-af", "silencedetect=noise=%.1fdB:d=%.2f" % (limiar_db, pausa_min),
                     "-f", "null", "-"], stderr=True)
    except RuntimeError:
        return [(0.0, duracao)]

    silencios = []
    inicio = None
    for linha in log.splitlines():
        m = re.search(r"silence_start:\s*(-?[\d.]+)", linha)
        if m:
            inicio = max(0.0, float(m.group(1)))
        m = re.search(r"silence_end:\s*([\d.]+)", linha)
        if m and inicio is not None:
            silencios.append((inicio, float(m.group(1))))
            inicio = None
    if inicio is not None:
        silencios.append((inicio, duracao))

    falas, cursor = [], 0.0
    for s0, s1 in silencios:
        if s0 - cursor > 0.05:
            falas.append((cursor, min(s0, duracao)))
        cursor = max(cursor, s1)
    if duracao - cursor > 0.05:
        falas.append((cursor, duracao))
    if not falas:
        return [(0.0, duracao)]

    # Trava: se a deteccao engoliu mais de 55% do audio, ela esta cortando
    # fala e nao silencio. Melhor cair para a divisao por igual do que
    # dessincronizar a legenda.
    fracao = sum(f - i for i, f in falas) / float(duracao or 1)
    if fracao < 0.45:
        return [(0.0, duracao)]
    return falas


def tempo_real(pos, falas):
    """Converte uma posicao na linha do tempo 'so de fala' para o tempo real
    do audio, pulando os silencios."""
    restante = pos
    for ini, fim in falas:
        bloco = fim - ini
        if restante <= bloco:
            return ini + restante
        restante -= bloco
    return falas[-1][1]


def tem_filtro(nome):
    """Checa se este build de ffmpeg tem um filtro/fonte especifico."""
    if not hasattr(tem_filtro, "_cache"):
        saida = rodar(["ffmpeg", "-hide_banner", "-filters"])
        tem_filtro._cache = saida
    return re.search(r"^\s+[A-Z.]+\s+%s\s" % re.escape(nome),
                     tem_filtro._cache, re.M) is not None


def duracao_de(caminho):
    """Duracao em segundos de um arquivo de midia, via ffprobe."""
    saida = rodar([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", caminho,
    ])
    try:
        return float(saida.strip())
    except ValueError:
        morrer("nao consegui ler a duracao de %s" % caminho)


def tem_audio(caminho):
    saida = rodar([
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=index", "-of", "csv=p=0", caminho,
    ])
    return bool(saida.strip())


def achar_fonte(preferida=None):
    if preferida and os.path.isfile(preferida):
        return preferida
    for f in FONTES_CANDIDATAS:
        if os.path.isfile(f):
            return f
    morrer("nenhuma fonte TTF encontrada. Informe 'marca.fonte' no roteiro "
           "com o caminho de um arquivo .ttf")


def hex_para_ass(cor, alfa="00"):
    """'#1ec37a' -> '&H00_7a_c3_1e' (ASS usa AABBGGRR)."""
    c = cor.strip().lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        morrer("cor invalida: %s (use formato #rrggbb)" % cor)
    r, g, b = c[0:2], c[2:4], c[4:6]
    return "&H%s%s%s%s" % (alfa, b.upper(), g.upper(), r.upper())


# ------------------------------------------------------- legendas (karaoke)

PONTUACAO_PAUSA = {",": 0.9, ";": 1.1, ":": 1.1, ".": 1.5, "!": 1.5,
                   "?": 1.5, "...": 2.0, "—": 1.0, "–": 1.0}


def peso_palavra(palavra):
    """Peso relativo de tempo de uma palavra: tamanho + pausa da pontuacao."""
    limpa = palavra.strip()
    peso = len(re.sub(r"[^\wÀ-ÿ]", "", limpa)) + 1.0
    for sinal, extra in sorted(PONTUACAO_PAUSA.items(), key=lambda kv: -len(kv[0])):
        if limpa.endswith(sinal):
            peso += extra * 2.2
            break
    return peso


def quebrar_em_blocos(palavras, max_chars, max_linhas):
    """Agrupa palavras em blocos de legenda (cada bloco = 1 tela)."""
    blocos, linha_atual, bloco_atual, linhas_no_bloco = [], [], [], 0
    for p in palavras:
        tentativa = " ".join(linha_atual + [p])
        if linha_atual and len(tentativa) > max_chars:
            bloco_atual.append(list(linha_atual))
            linhas_no_bloco += 1
            linha_atual = [p]
            if linhas_no_bloco >= max_linhas:
                blocos.append(bloco_atual)
                bloco_atual, linhas_no_bloco = [], 0
        else:
            linha_atual.append(p)
    if linha_atual:
        bloco_atual.append(list(linha_atual))
    if bloco_atual:
        blocos.append(bloco_atual)
    return blocos


def normalizar(palavra):
    return re.sub(r"[^\wÀ-ÿ]", "", palavra).lower()


def metricas_legenda(canvas, marca):
    """Metricas da legenda compartilhadas entre o .ass e o posicionamento
    do avatar, para que um nunca invada o outro."""
    L, A = canvas
    vertical = A > L
    tamanho = marca.get("tamanho_legenda") or (72 if vertical else 64)
    margem_v = marca.get("margem_legenda") or (round(A * 0.17) if vertical
                                               else round(A * 0.11))
    max_chars = marca.get("max_chars_linha") or (20 if vertical else 32)
    max_linhas = int(marca.get("max_linhas_legenda", 2))
    # altura total ocupada pela faixa de legenda, medida a partir da base
    banda = margem_v + round(max_linhas * tamanho * 1.5)
    return tamanho, margem_v, max_chars, max_linhas, banda


def gerar_ass(cenas, canvas, marca, caminho_ass):
    """
    Gera o arquivo .ass com legenda estilo karaoke (palavra acende no tempo
    em que e falada). O tempo de cada palavra e estimado proporcionalmente
    ao tamanho da palavra e as pausas de pontuacao, dentro da duracao real
    do audio da cena.
    """
    L, A = canvas
    vertical = A > L

    cor_normal = hex_para_ass(marca.get("cor_legenda", "#FFFFFF"))
    cor_acesa = hex_para_ass(marca.get("cor", "#1EC37A"))
    cor_destaque = hex_para_ass(marca.get("cor_destaque", marca.get("cor", "#1EC37A")))
    cor_contorno = hex_para_ass(marca.get("cor_contorno", "#000000"))

    tamanho, margem_v, max_chars, max_linhas, _banda = metricas_legenda(canvas, marca)
    contorno = max(3, round(tamanho * 0.075))
    nome_fonte = marca.get("nome_fonte", "DejaVu Sans")

    cab = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: %d" % L,
        "PlayResY: %d" % A,
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: VSL,%s,%d,%s,%s,%s,&H64000000,-1,0,0,0,100,100,0,0,1,%d,2,2,%d,%d,%d,1"
        % (nome_fonte, tamanho, cor_acesa, cor_normal, cor_contorno,
           contorno, round(L * 0.06), round(L * 0.06), margem_v),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    def tc(seg):
        seg = max(0.0, seg)
        h = int(seg // 3600)
        m = int((seg % 3600) // 60)
        s = seg % 60
        return "%d:%02d:%05.2f" % (h, m, s)

    eventos = []
    t0 = 0.0
    for cena in cenas:
        dur = cena["_duracao"]
        texto = (cena.get("texto") or "").strip()
        if not texto or cena.get("legenda") is False:
            t0 += dur
            continue

        destaques = set()
        for frase in cena.get("destaque", []) or []:
            for p in frase.split():
                destaques.add(normalizar(p))

        palavras = texto.split()
        blocos = quebrar_em_blocos(palavras, max_chars, max_linhas)

        pesos = [peso_palavra(p) for p in palavras]
        total_peso = sum(pesos) or 1.0

        # Com narracao gravada, a legenda segue a FALA de verdade: detecta
        # onde ha voz e distribui as palavras so nesses trechos, parando nas
        # pausas. Sem narracao (modo rascunho), divide o tempo por igual.
        if cena.get("_audio"):
            falas = segmentos_de_fala(cena["_audio"], dur)
            fala_total = sum(f - i for i, f in falas) or dur
            tempos, acumulado = [], 0.0
            for p in pesos:
                ini = tempo_real(acumulado, falas)
                acumulado += fala_total * (p / total_peso)
                fim = tempo_real(min(acumulado, fala_total), falas)
                tempos.append((t0 + ini, t0 + max(fim, ini + 0.04)))
        else:
            util = max(0.1, dur - min(0.25, dur * 0.06))
            tempos, acumulado = [], 0.0
            for p in pesos:
                ini = acumulado
                acumulado += util * (p / total_peso)
                tempos.append((t0 + ini, t0 + acumulado))

        idx = 0
        for n_bloco, bloco in enumerate(blocos):
            partes_linha = []
            i_primeira = idx
            for linha in bloco:
                tokens = []
                for palavra in linha:
                    ini, fim = tempos[idx]
                    cs = max(1, int(round((fim - ini) * 100)))
                    cor = cor_destaque if normalizar(palavra) in destaques else cor_acesa
                    tokens.append("{\\kf%d\\1c%s}%s" % (cs, cor, palavra))
                    idx += 1
                partes_linha.append(" ".join(tokens))
            inicio_bloco = tempos[i_primeira][0]
            fim_bloco = tempos[idx - 1][1]
            # o ultimo bloco da cena segura ate o corte, para nao abrir um
            # vao sem legenda no fim de cada cena
            if n_bloco == len(blocos) - 1:
                fim_bloco = t0 + dur
            eventos.append(
                "Dialogue: 0,%s,%s,VSL,,0,0,0,,%s"
                % (tc(inicio_bloco), tc(fim_bloco), "\\N".join(partes_linha))
            )
        t0 += dur

    with open(caminho_ass, "w", encoding="utf-8") as fh:
        fh.write("\n".join(cab + eventos) + "\n")
    return caminho_ass


# ------------------------------------------------------------ mascara avatar

def gerar_mascara_circulo(lado, destino):
    """PNG em escala de cinza: circulo branco em fundo preto (canal alfa)."""
    rodar([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=black:s=%dx%d" % (lado, lado),
        "-vf", "format=gray,geq=lum='clip((%d-hypot(X-%d,Y-%d))*96+128,0,255)'"
               % (lado // 2 - 3, lado // 2, lado // 2),
        "-frames:v", "1", destino,
    ])
    return destino


# ------------------------------------------------------------------- fundos

def montar_fundo_rotativo(clipes, canvas, dur, intervalo, destino):
    """Alterna varios clipes de B-roll dentro de uma mesma cena.

    Cada clipe fica no ar por `intervalo` segundos; quando a lista acaba,
    volta ao primeiro, mas avancando no tempo do clipe para nao repetir
    sempre o mesmo trecho.
    """
    L, A = canvas
    n = max(1, int(math.ceil(dur / float(intervalo))))
    args = ["ffmpeg", "-y", "-v", "error"]
    filtros, rotulos = [], []
    restante = dur
    for k in range(n):
        clipe = clipes[k % len(clipes)]
        t = min(float(intervalo), restante)
        if t <= 0.02:
            break
        restante -= t
        volta = k // len(clipes)          # quantas vezes ja usamos este clipe
        inicio = volta * float(intervalo)
        args += ["-stream_loop", "-1", "-t", "%.3f" % (inicio + t + 0.5), "-i", clipe]
        filtros.append(
            "[%d:v]scale=%d:%d:force_original_aspect_ratio=increase,"
            "crop=%d:%d,fps=%d,setsar=1,trim=start=%.3f:duration=%.3f,"
            "setpts=PTS-STARTPTS[s%d]"
            % (len(rotulos), L, A, L, A, FPS, inicio, t, k))
        rotulos.append("[s%d]" % k)
    filtros.append("%sconcat=n=%d:v=1:a=0[out]" % ("".join(rotulos), len(rotulos)))
    args += ["-filter_complex", ";".join(filtros), "-map", "[out]",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-r", str(FPS), "-t", "%.3f" % dur, destino]
    rodar(args)
    return destino


def entrada_fundo(cena, canvas, dur, trabalho):
    """
    Devolve (lista_de_args_de_entrada, etiqueta_do_stream) para o fundo da cena.
    Aceita arquivo de video, imagem, ou fundo procedural (sem nenhum asset).
    """
    L, A = canvas
    fundo = cena.get("fundo")

    # lista de clipes -> pre-renderiza um fundo com eles se alternando
    if isinstance(fundo, (list, tuple)):
        faltando = [c for c in fundo if not os.path.isfile(c)]
        if faltando:
            morrer("clipe de fundo nao encontrado: %s" % faltando[0])
        chave = hashlib.md5(("|".join(fundo) + "|%.3f" % dur).encode()).hexdigest()[:10]
        alvo = os.path.join(trabalho, "fundo_rot_%s.mp4" % chave)
        montar_fundo_rotativo(fundo, canvas, dur,
                              cena.get("broll_intervalo", 3.0), alvo)
        return (["-i", alvo], "video")

    if fundo and not str(fundo).startswith("procedural"):
        if not os.path.isfile(fundo):
            morrer("fundo nao encontrado: %s" % fundo)
        ext = os.path.splitext(fundo)[1].lower()
        if ext in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
            return (["-loop", "1", "-t", "%.3f" % dur, "-i", fundo], "imagem")
        return (["-stream_loop", "-1", "-t", "%.3f" % dur, "-i", fundo], "video")

    # fundo procedural: gradiente animado, sem precisar de nenhum arquivo
    cor_a = cena.get("fundo_cor_a", "0x12263F")
    cor_b = cena.get("fundo_cor_b", "0x1E4C7C")
    if tem_filtro("gradients"):
        fonte = ("gradients=s=%dx%d:c0=%s:c1=%s:x0=0:y0=%d:x1=%d:y1=0:"
                 "speed=0.010:r=%d:d=%.3f"
                 % (L, A, cor_a, cor_b, A, L, FPS, dur))
    else:
        fonte = "color=c=%s:s=%dx%d:r=%d:d=%.3f" % (cor_a, L, A, FPS, dur)
    # Nada de granulado aqui: ruido aleatorio e incompressivel e fez o
    # arquivo final saltar de 5 MB para 270 MB. O gradiente em movimento
    # ja evita o aspecto chapado.
    return (["-f", "lavfi", "-t", "%.3f" % dur, "-i", fonte], "procedural")


# ------------------------------------------------------------ render da cena

def renderizar_cena(cena, i, canvas, marca, trabalho, mascara,
                    primeira=False, ultima=False):
    L, A = canvas
    dur = cena["_duracao"]
    layout = cena.get("layout", "fundo_broll")
    saida = os.path.join(trabalho, "cena_%03d.mp4" % i)

    entradas, tipo_fundo = entrada_fundo(cena, canvas, dur, trabalho)
    args = ["ffmpeg", "-y", "-v", "error"] + entradas
    idx = 1  # proximo indice de entrada

    avatar = cena.get("avatar")
    usa_avatar = bool(avatar) and layout != "so_fundo"

    # ---- geometria do avatar (tudo em pixels inteiros, sem expressao)
    if usa_avatar:
        if not os.path.isfile(avatar):
            morrer("avatar nao encontrado: %s" % avatar)
        if layout == "avatar_cheio":
            prop = float(cena.get("avatar_escala", 1.0))
            aw = max(2, int(L * prop) // 2 * 2)
            ah = max(2, int(A * prop) // 2 * 2)
            ax, ay = (L - aw) // 2, (A - ah) // 2
            circulo = bool(cena.get("avatar_circulo", False))
        else:
            prop = float(cena.get("avatar_escala", 0.34 if A > L else 0.30))
            lado = max(2, int(min(L, A) * prop) // 2 * 2)
            aw = ah = lado
            m = int(min(L, A) * 0.055)
            # sobe o avatar para ficar acima da faixa real de legenda
            _t, _mv, _mc, _ml, banda = metricas_legenda(canvas, marca)
            folga_legenda = banda + int(A * 0.015)
            mapa = {
                "baixo-direita":  (L - aw - m,      A - ah - m - folga_legenda),
                "baixo-esquerda": (m,               A - ah - m - folga_legenda),
                "alto-direita":   (L - aw - m,      m),
                "alto-esquerda":  (m,               m),
                "centro":         ((L - aw) // 2,   (A - ah) // 2),
                "centro-alto":    ((L - aw) // 2,   int(A * 0.12)),
            }
            ax, ay = mapa.get(cena.get("avatar_posicao", "baixo-direita"),
                              mapa["baixo-direita"])
            circulo = bool(cena.get("avatar_circulo", True))
        ax = max(0, min(ax, L - aw))
        ay = max(0, min(ay, A - ah))
        # trava geral: em qualquer posicao de PiP o avatar fica acima da
        # faixa de legenda (inclusive em "centro", que antes a ignorava)
        if layout != "avatar_cheio" and (cena.get("texto") or "").strip() \
                and cena.get("legenda") is not False:
            _t, _mv, _mc, _ml, _banda = metricas_legenda(canvas, marca)
            limite = A - _banda - ah
            if limite >= 0:
                ay = min(ay, limite)
        anel = max(3, int(min(L, A) * 0.006)) if circulo else 0
        rw = aw + anel * 2
        rx, ry = max(0, ax - anel), max(0, ay - anel)

    # ---- entradas
    if usa_avatar:
        args += ["-stream_loop", "-1", "-t", "%.3f" % dur, "-i", avatar]
        idx_avatar = idx
        idx += 1

    audio = cena.get("_audio")
    if audio:
        args += ["-i", audio]
    else:
        args += ["-f", "lavfi", "-t", "%.3f" % dur,
                 "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    idx_audio = idx
    idx += 1

    if usa_avatar and circulo:
        args += ["-i", mascara]
        idx_mascara = idx
        idx += 1
        args += ["-f", "lavfi", "-t", "%.3f" % dur,
                 "-i", "color=c=%s:s=%dx%d:r=%d"
                 % (marca.get("cor", "#1EC37A"), rw, rw, FPS)]
        idx_cor_anel = idx
        idx += 1

    # ---- cadeia de video
    f = []
    escurecer = cena.get("escurecer_fundo")
    if escurecer is None:
        if tipo_fundo == "procedural":
            escurecer = 0.0
        else:
            escurecer = -0.14 if layout != "avatar_cheio" else -0.05
    desfoque = cena.get("desfoque_fundo")
    if desfoque is None:
        if tipo_fundo == "procedural":
            desfoque = 0
        else:
            desfoque = 14 if layout == "fundo_broll" else 0

    base = ("[0:v]scale=%d:%d:force_original_aspect_ratio=increase,"
            "crop=%d:%d,fps=%d,setsar=1" % (L, A, L, A, FPS))
    if cena.get("zoom", True) and tipo_fundo in ("video", "imagem"):
        base += (",zoompan=z='min(max(zoom,pzoom)+0.0004,1.12)':d=1"
                 ":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=%dx%d:fps=%d"
                 % (L, A, FPS))
    if desfoque:
        base += ",gblur=sigma=%g" % desfoque
    base += ",eq=brightness=%g:saturation=%g" % (escurecer, cena.get("saturacao_fundo", 0.92))
    base += ",trim=duration=%.3f,setpts=PTS-STARTPTS[fundo]" % dur
    f.append(base)
    ultimo = "fundo"

    if usa_avatar:
        f.append("[%d:v]scale=%d:%d:force_original_aspect_ratio=increase,"
                 "crop=%d:%d,fps=%d,setsar=1,trim=duration=%.3f,"
                 "setpts=PTS-STARTPTS[av]"
                 % (idx_avatar, aw, ah, aw, ah, FPS, dur))
        if circulo:
            # anel circular da cor da marca, atras do avatar
            f.append("[%d:v]scale=%d:%d,format=gray[rmk]" % (idx_mascara, rw, rw))
            f.append("[%d:v]format=yuva420p[rc]" % idx_cor_anel)
            f.append("[rc][rmk]alphamerge[anel]")
            f.append("[%s][anel]overlay=x=%d:y=%d:format=auto[fa]" % (ultimo, rx, ry))
            ultimo = "fa"
            # avatar recortado em circulo
            f.append("[%d:v]scale=%d:%d,format=gray[mk]" % (idx_mascara, aw, ah))
            f.append("[av]format=yuva420p[avf]")
            f.append("[avf][mk]alphamerge[ava]")
            f.append("[%s][ava]overlay=x=%d:y=%d:format=auto[comp]" % (ultimo, ax, ay))
        else:
            f.append("[%s][av]overlay=x=%d:y=%d:format=auto[comp]" % (ultimo, ax, ay))
        ultimo = "comp"

    if cena.get("vinheta", True) and tem_filtro("vignette"):
        f.append("[%s]vignette=angle=PI/5[vin]" % ultimo)
        ultimo = "vin"

    # Fade so na abertura e no encerramento do VIDEO INTEIRO.
    # Fade em toda cena faz a imagem piscar preto a cada corte e destroi o
    # ritmo da VSL, entao entre cenas o corte e seco.
    fade = min(0.5, dur / 4.0)
    etapas = []
    if primeira:
        etapas.append("fade=t=in:st=0:d=%.3f" % fade)
    if ultima:
        etapas.append("fade=t=out:st=%.3f:d=%.3f" % (max(0.0, dur - fade), fade))
    f.append("[%s]%s[vout]" % (ultimo, ",".join(etapas) if etapas else "null"))

    # microfade no audio evita estalo na emenda entre cenas
    corte = min(0.012, dur / 20.0)
    f.append("[%d:a]aformat=sample_fmts=fltp:sample_rates=48000:"
             "channel_layouts=stereo,atrim=duration=%.3f,asetpts=PTS-STARTPTS,"
             "apad=whole_dur=%.3f,afade=t=in:st=0:d=%.3f,"
             "afade=t=out:st=%.3f:d=%.3f[aout]"
             % (idx_audio, dur, dur, corte, max(0.0, dur - corte), corte))

    args += [
        "-filter_complex", ";".join(f),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", str(FPS * 2),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", "-t", "%.3f" % dur, saida,
    ]
    rodar(args)
    return saida


# ------------------------------------------------------------------ pipeline

def resolver_audio_e_duracao(cena, raiz):
    """Define o audio da cena e sua duracao real (ou estimada, em rascunho)."""
    narracao = cena.get("narracao")
    if narracao:
        caminho = narracao if os.path.isabs(narracao) else os.path.join(raiz, narracao)
        if not os.path.isfile(caminho):
            morrer("narracao nao encontrada: %s\n       (grave o audio ou remova "
                   "o campo 'narracao' para rodar em modo rascunho)" % caminho)
        cena["_audio"] = caminho
        cena["_duracao"] = duracao_de(caminho)
        cena["_estimada"] = False
        return

    cena["_audio"] = None
    if cena.get("duracao"):
        cena["_duracao"] = float(cena["duracao"])
    else:
        palavras = len((cena.get("texto") or "").split())
        cena["_duracao"] = max(1.8, round(palavras / PPS_PT + 0.6, 2))
    cena["_estimada"] = True


def montar(roteiro, raiz, formato, destino, manter_trabalho=False):
    L, A = FORMATOS[formato]
    marca = roteiro.get("marca", {}) or {}
    marca.setdefault("cor", "#1EC37A")
    cenas = roteiro.get("cenas") or []
    if not cenas:
        morrer("o roteiro nao tem nenhuma cena em 'cenas'")

    trabalho = tempfile.mkdtemp(prefix="vsl_%s_" % formato.replace(":", "x"))
    try:
        for c in cenas:
            resolver_audio_e_duracao(c, raiz)

        total = sum(c["_duracao"] for c in cenas)
        estimadas = sum(1 for c in cenas if c["_estimada"])
        print("  formato %s (%dx%d) | %d cenas | %s" % (
            formato, L, A, len(cenas),
            ("%dm%02ds" % (total // 60, total % 60)) if total >= 60 else "%.1fs" % total))
        if estimadas:
            print("  [rascunho] %d/%d cenas sem audio de narracao: duracao estimada"
                  % (estimadas, len(cenas)))

        mascara = gerar_mascara_circulo(1024, os.path.join(trabalho, "mask.png"))

        partes = []
        for i, cena in enumerate(cenas):
            print("    cena %d/%d ..." % (i + 1, len(cenas)), end="", flush=True)
            partes.append(renderizar_cena(
                cena, i, (L, A), marca, trabalho, mascara,
                primeira=(i == 0), ultima=(i == len(cenas) - 1)))
            print(" ok")

        # concatena as cenas sem reencodar (parametros identicos)
        lista = os.path.join(trabalho, "lista.txt")
        with open(lista, "w", encoding="utf-8") as fh:
            for p in partes:
                fh.write("file '%s'\n" % os.path.abspath(p).replace("'", "'\\''"))
        bruto = os.path.join(trabalho, "bruto.mp4")
        rodar(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
               "-i", lista, "-c", "copy", bruto])

        # legenda karaoke sobre o video inteiro (tempos continuos)
        ass = gerar_ass(cenas, (L, A), marca, os.path.join(trabalho, "legenda.ass"))
        fonte = achar_fonte(marca.get("fonte"))
        dir_fonte = os.path.dirname(fonte)

        musica = roteiro.get("musica")
        if musica:
            musica = musica if os.path.isabs(musica) else os.path.join(raiz, musica)
            if not os.path.isfile(musica):
                morrer("musica nao encontrada: %s" % musica)

        args = ["ffmpeg", "-y", "-v", "error", "-i", bruto]
        if musica:
            args += ["-stream_loop", "-1", "-i", musica]

        vf = ("ass=filename='%s':fontsdir='%s'"
              % (ass.replace("\\", "/").replace(":", "\\:"), dir_fonte))

        logo = roteiro.get("logo")
        if logo:
            logo = logo if os.path.isabs(logo) else os.path.join(raiz, logo)
            if os.path.isfile(logo):
                args += ["-i", logo]
                i_logo = 2 if musica else 1
                lw = int(L * 0.11)
                fc = ("[0:v]%s[leg];[%d:v]scale=%d:-1[lg];"
                      "[leg][lg]overlay=x=W-w-%d:y=%d:format=auto[v]"
                      % (vf, i_logo, lw, int(L * 0.035), int(A * 0.045)))
            else:
                morrer("logo nao encontrada: %s" % logo)
        else:
            fc = "[0:v]%s[v]" % vf

        if musica:
            vol = float(roteiro.get("volume_musica", 0.16))
            fc += (";[1:a]aformat=sample_fmts=fltp:sample_rates=48000:"
                   "channel_layouts=stereo,volume=%g[mus]" % vol)
            fc += ";[0:a]asplit=2[nar1][nar2]"
            fc += (";[mus][nar2]sidechaincompress=threshold=0.04:ratio=7:"
                   "attack=12:release=320[musd]")
            fc += (";[nar1][musd]amix=inputs=2:duration=first:"
                   "dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]")
        else:
            fc += ";[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]"

        args += [
            "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19",
            "-pix_fmt", "yuv420p", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", "-shortest", destino,
        ]
        rodar(args)
        return destino
    finally:
        if manter_trabalho:
            print("  [debug] arquivos intermediarios em %s" % trabalho)
        else:
            shutil.rmtree(trabalho, ignore_errors=True)


# ----------------------------------------------------------------------- cli

def main():
    ap = argparse.ArgumentParser(
        description="Monta uma VSL a partir de um roteiro JSON (texto -> video).")
    ap.add_argument("roteiro", help="arquivo .json do roteiro")
    ap.add_argument("--formato", default=None,
                    help="16:9 | 9:16 | 1:1 | 4:5 | todos "
                         "(padrao: o que estiver no roteiro, ou 16:9)")
    ap.add_argument("--saida", default=None, help="caminho do mp4 de saida")
    ap.add_argument("--debug", action="store_true",
                    help="mantem os arquivos intermediarios")
    a = ap.parse_args()

    for exe in ("ffmpeg", "ffprobe"):
        if not shutil.which(exe):
            morrer("%s nao encontrado no PATH. Instale o ffmpeg." % exe)

    if not os.path.isfile(a.roteiro):
        morrer("roteiro nao encontrado: %s" % a.roteiro)
    with open(a.roteiro, encoding="utf-8") as fh:
        try:
            roteiro = json.load(fh)
        except json.JSONDecodeError as e:
            morrer("JSON invalido em %s: %s" % (a.roteiro, e))

    # caminhos relativos no roteiro sao relativos a pasta do roteiro
    raiz = os.path.dirname(os.path.abspath(a.roteiro)) or "."
    def resolver(v):
        if not v or str(v).startswith("procedural") or os.path.isabs(v):
            return v
        return os.path.join(raiz, v)

    for cena in roteiro.get("cenas", []):
        for campo in ("fundo", "avatar"):
            v = cena.get(campo)
            if isinstance(v, (list, tuple)):
                cena[campo] = [resolver(x) for x in v]
            elif v:
                cena[campo] = resolver(v)

    if a.formato:
        formatos = list(FORMATOS) if a.formato == "todos" else [a.formato]
    else:
        formatos = roteiro.get("formatos") or ["16:9"]
    for f in formatos:
        if f not in FORMATOS:
            morrer("formato desconhecido: %s (use %s ou 'todos')"
                   % (f, " | ".join(FORMATOS)))

    base = re.sub(r"[^\w\-]+", "-",
                  (roteiro.get("titulo") or "vsl").strip().lower()).strip("-") or "vsl"
    pasta_saida = os.path.join(raiz, "saida")
    os.makedirs(pasta_saida, exist_ok=True)

    print("\nMontando: %s" % (roteiro.get("titulo") or a.roteiro))
    finais = []
    for f in formatos:
        if a.saida and len(formatos) == 1:
            destino = a.saida
        else:
            destino = os.path.join(pasta_saida, "%s_%s.mp4" % (base, f.replace(":", "x")))
        os.makedirs(os.path.dirname(os.path.abspath(destino)), exist_ok=True)
        montar(roteiro, raiz, f, destino, manter_trabalho=a.debug)
        tam = os.path.getsize(destino) / 1e6
        print("  -> %s (%.1f MB)\n" % (destino, tam))
        finais.append(destino)

    print("Pronto: %d video(s) gerado(s)." % len(finais))


if __name__ == "__main__":
    main()
