# Motor de VSL — texto vira vídeo

Pipeline para produzir VSL (Video Sales Letter) com avatar próprio: você escreve
o roteiro, o motor monta o vídeo com narração, legenda karaokê, B-roll de fundo,
trilha e cortes — em 16:9, 9:16, 1:1 e 4:5.

Sem dependência nenhuma de biblioteca: **só Python 3 + ffmpeg**.

```bash
python3 bin/montar.py roteiro.exemplo.json --formato todos
```

---

## Como as peças se dividem

A produção tem três etapas, e **só a terceira roda em qualquer máquina**:

| Etapa | O que faz | Onde roda | Custo |
|---|---|---|---|
| 1. Voz | Texto → narração com a sua voz | GPU (Colab grátis) ou gravação própria | R$ 0 |
| 2. Avatar | Narração + vídeo seu → você falando o texto | GPU (Colab grátis) | R$ 0 |
| 3. Montagem | Avatar + B-roll + legenda + trilha → VSL final | **Aqui, qualquer CPU** | R$ 0 |

As etapas 1 e 2 estão no notebook [`gpu/avatar_colab.ipynb`](gpu/avatar_colab.ipynb)
(abra no Google Colab, GPU T4 gratuita). A etapa 3 é este motor.

### Por que 1 e 2 não rodam em CPU

Lipsync por difusão precisa de VRAM. O LatentSync pede 8 GB (v1.5) ou 18 GB (v1.6).
Em CPU o processamento sai na casa de horas por minuto de vídeo — inviável na prática.

---

## Ferramentas escolhidas e por quê

A escolha foi filtrada por **licença que permite uso comercial**, porque VSL é
peça de venda. Isso elimina opções populares:

| Ferramenta | Licença | Serve pra VSL comercial? |
|---|---|---|
| **LatentSync** (ByteDance) | Apache 2.0 | ✅ **Escolhida** — melhor qualidade das livres |
| **Chatterbox pt-br** (Resemble) | MIT | ✅ **Escolhida** — clona voz, tem modelo pt-br dedicado |
| Wav2Lip | Não comercial | ❌ Proibido para uso comercial |
| XTTS-v2 (Coqui) | CPML, não comercial | ❌ Proibido para uso comercial |

> Nota: o Chatterbox foi arquivado pela Resemble AI em agosto/2026. O código
> continua público sob MIT e funcional, mas sem manutenção.

**A alternativa mais simples continua sendo gravar a própria voz** lendo o roteiro:
custo zero, qualidade perfeita, nenhuma questão de licença, e em VSL costuma
converter melhor que voz sintética.

---

## Uso

### Rodar o exemplo

Funciona imediatamente, sem você ter nenhum material — usa fundos gerados por
software e placeholders:

```bash
python3 bin/montar.py roteiro.exemplo.json --formato 16:9
```

Saída em `saida/`.

### Modo rascunho

Cena sem `narracao` tem a duração **estimada** pelo número de palavras
(~2,6 palavras/segundo em português). Serve pra ver o ritmo da VSL antes de
gravar qualquer áudio. O motor avisa quando está nesse modo.

### Modo final

Com os `.wav` de narração apontados, a duração de cada cena passa a ser a
**duração real do áudio**, e a legenda karaokê acompanha.

---

## Formato do roteiro

```jsonc
{
  "titulo": "VSL Previdenciario",
  "formatos": ["16:9", "9:16"],
  "musica": "entrada/musica/fundo.mp3",   // opcional, abaixa sozinha na fala
  "volume_musica": 0.16,
  "logo": "entrada/logo.png",             // opcional, canto superior direito
  "marca": {
    "cor": "#1EC37A",            // anel do avatar + palavra sendo falada
    "cor_destaque": "#FFD84D",   // palavras listadas em "destaque"
    "cor_legenda": "#FFFFFF",    // palavra ainda não falada
    "nome_fonte": "DejaVu Sans",
    "fonte": "/caminho/para/Fonte-Bold.ttf"   // opcional
  },
  "cenas": [
    {
      "texto": "Você trabalhou a vida toda e o INSS negou seu benefício?",
      "destaque": ["INSS negou"],
      "narracao": "entrada/narracao/cena_01.wav",
      "avatar": "entrada/avatar/avatar.mp4",
      "fundo": ["entrada/broll/escritorio.mp4",
                "entrada/broll/documentos.mp4",
                "entrada/broll/aperto-de-mao.mp4"],
      "broll_intervalo": 3,
      "layout": "fundo_broll",
      "avatar_posicao": "baixo-direita"
    }
  ]
}
```

### Campos de cena

| Campo | Padrão | O que faz |
|---|---|---|
| `texto` | — | Vira a legenda karaokê (e o que você narra) |
| `destaque` | `[]` | Palavras que acendem na cor de destaque |
| `narracao` | — | `.wav`/`.mp3` da cena. Sem ele, entra modo rascunho |
| `duracao` | auto | Força a duração em segundos |
| `avatar` | — | Vídeo seu. Sem ele, a cena fica só com fundo e legenda |
| `fundo` | `procedural` | Vídeo, imagem, `procedural` (gradiente gerado, sem arquivo), ou **uma lista de vídeos** que se alternam dentro da cena |
| `broll_intervalo` | `3.0` | Segundos que cada clipe da lista fica no ar antes de trocar |
| `layout` | `fundo_broll` | `fundo_broll` (B-roll atrás, avatar em círculo), `avatar_cheio` (avatar na tela toda), `so_fundo` (sem avatar) |
| `avatar_posicao` | `baixo-direita` | `baixo-esquerda`, `alto-direita`, `alto-esquerda`, `centro`, `centro-alto` |
| `avatar_escala` | `0.30`–`0.34` | Proporção do lado menor da tela |
| `avatar_circulo` | `true` | Recorte circular com anel na cor da marca |
| `fundo_cor_a` / `fundo_cor_b` | azul-escuro | Cores do gradiente procedural (`0xRRGGBB`) |
| `desfoque_fundo` | `14` | Desfoque do fundo (0 desliga) |
| `escurecer_fundo` | `-0.14` | Escurece o fundo pra legenda ler |
| `zoom` | `true` | Zoom lento no fundo (efeito Ken Burns) |
| `vinheta` | `true` | Escurece as bordas |
| `legenda` | `true` | `false` tira a legenda da cena |

---

## O que o motor faz automaticamente

- **Legenda karaokê alinhada à fala**: divide o texto em blocos de 2 linhas e
  acende palavra por palavra. Com narração gravada, o motor **detecta onde há voz
  no áudio** (limiar adaptativo, calculado a partir do piso de ruído do próprio
  arquivo) e distribui as palavras só nos trechos falados, parando nas pausas.
  Se a detecção não for confiável, cai automaticamente para a divisão
  proporcional ao tamanho das palavras — nunca dessincroniza por tentar adivinhar.
- **B-roll rotativo**: uma cena pode ter vários vídeos de fundo se alternando a
  cada N segundos, sem você cortar nada na mão.
- **Corte seco entre cenas**: o fade acontece só na abertura e no encerramento do
  vídeo. Fade a cada cena faz a imagem piscar preto e destrói o ritmo da VSL.
- **Avatar nunca encosta na legenda**: a posição é calculada a partir da altura
  real da faixa de legenda, em todos os formatos.
- **Trilha com ducking**: a música abaixa sozinha quando você fala
  (`sidechaincompress`) e sobe nas pausas.
- **Volume normalizado** em -14 LUFS, que é o padrão de YouTube e Instagram.
- **Corte limpo** entre cenas, com fade curto nas bordas.

## Estrutura

```
vsl/
├── bin/montar.py              # o motor
├── roteiro.exemplo.json       # exemplo que roda sem material nenhum
├── gpu/avatar_colab.ipynb     # voz clonada + lipsync (Colab grátis)
├── entrada/
│   ├── avatar/                # seu vídeo base / avatar gerado
│   ├── broll/                 # vídeos de fundo
│   ├── narracao/              # áudios por cena
│   └── musica/                # trilha
└── saida/                     # VSLs renderizadas
```

## Requisitos

- Python 3.8+
- ffmpeg e ffprobe no PATH (`sudo apt install ffmpeg` / `brew install ffmpeg`)

## Onde conseguir B-roll de graça

Pexels, Pixabay e Coverr têm bibliotecas gratuitas e liberadas para uso comercial.
Baixe os clipes em `entrada/broll/`. Alternativa sem baixar nada: use
`"fundo": "procedural"`, que gera um gradiente animado por software.
