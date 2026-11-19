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


def rodar(cmd, silencioso=True):
    """Executa um comando e devolve stdout. Levanta erro com o log do ffmpeg."""
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        cauda = (res.stderr or "").strip().splitlines()[-25:]
        raise RuntimeError(
            "comando falhou:\n  %s\n\n%s" % (" ".join(cmd), "\n".join(cauda))
        )
    return res.stdout


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

        # tempo proporcional por palavra dentro da duracao real da cena
        pesos = [peso_palavra(p) for p in palavras]
        total_peso = sum(pesos) or 1.0
        # pequena folga no fim para a legenda nao terminar colada no corte
        util = max(0.1, dur - min(0.25, dur * 0.06))
        dur_palavra = {}
        acc = 0.0
        for i, p in enumerate(palavras):
            d = util * (pesos[i] / total_peso)
            dur_palavra[i] = d
            acc += d

        idx = 0
        t_bloco = t0
        for bloco in blocos:
            partes_linha = []
            dur_bloco = 0.0
            for linha in bloco:
                tokens = []
                for palavra in linha:
                    d = dur_palavra[idx]
                    cs = max(1, int(round(d * 100)))
                    if normalizar(palavra) in destaques:
                        tokens.append("{\\kf%d\\1c%s}%s" % (cs, cor_destaque, palavra))
                    else:
                        tokens.append("{\\kf%d\\1c%s}%s" % (cs, cor_acesa, palavra))
                    dur_bloco += d
                    idx += 1
                partes_linha.append(" ".join(tokens))
            texto_ass = "\\N".join(partes_linha)
            eventos.append(
                "Dialogue: 0,%s,%s,VSL,,0,0,0,,%s"
                % (tc(t_bloco), tc(t_bloco + dur_bloco), texto_ass)
            )
            t_bloco += dur_bloco
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

def entrada_fundo(cena, canvas, dur, trabalho):
    """
    Devolve (lista_de_args_de_entrada, etiqueta_do_stream) para o fundo da cena.
    Aceita arquivo de video, imagem, ou fundo procedural (sem nenhum asset).
    """
    L, A = canvas
    fundo = cena.get("fundo")

    if fundo and not str(fundo).startswith("procedural"):
        if not os.path.isfile(fundo):
            morrer("fundo nao encontrado: %s" % fundo)
        ext = os.path.splitext(fundo)[1].lower()
        if ext in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
            return (["-loop", "1", "-t", "%.3f" % dur, "-i", fundo], "imagem")
        return (["-stream_loop", "-1", "-t", "%.3f" % dur, "-i", fundo], "video")

    # fundo procedural: gradiente animado, sem precisar de nenhum arquivo
    cor_a = cena.get("fundo_cor_a", "0x0A1626")
    cor_b = cena.get("fundo_cor_b", "0x14395F")
    if tem_filtro("gradients"):
        src = ("gradients=s=%dx%d:c0=%s:c1=%s:x0=0:y0=0:x1=%d:y1=%d:"
               "speed=0.012:r=%d:d=%.3f" % (L, A, cor_a, cor_b, L, A, FPS, dur))
    else:
        src = "color=c=%s:s=%dx%d:r=%d:d=%.3f" % (cor_a, L, A, FPS, dur)
    return (["-f", "lavfi", "-t", "%.3f" % dur, "-i", src], "procedural")


# ------------------------------------------------------------ render da cena

def renderizar_cena(cena, i, canvas, marca, trabalho, mascara):
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
        escurecer = -0.14 if layout != "avatar_cheio" else -0.05
    desfoque = cena.get("desfoque_fundo")
    if desfoque is None:
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

    fade = min(0.22, dur / 6.0)
    f.append("[%s]fade=t=in:st=0:d=%.3f,fade=t=out:st=%.3f:d=%.3f[vout]"
             % (ultimo, fade, max(0.0, dur - fade), fade))

    f.append("[%d:a]aformat=sample_fmts=fltp:sample_rates=48000:"
             "channel_layouts=stereo,atrim=duration=%.3f,asetpts=PTS-STARTPTS,"
             "apad=whole_dur=%.3f[aout]" % (idx_audio, dur, dur))

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
            partes.append(renderizar_cena(cena, i, (L, A), marca, trabalho, mascara))
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
    for cena in roteiro.get("cenas", []):
        for campo in ("fundo", "avatar"):
            v = cena.get(campo)
            if v and not str(v).startswith("procedural") and not os.path.isabs(v):
                cena[campo] = os.path.join(raiz, v)

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
