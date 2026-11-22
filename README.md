# 🎭 Coup Online

Versão web peer-to-peer do jogo de cartas **Coup** para jogar com amigos.  
Site estático (GitHub Pages). Sem Node, sem Docker, sem servidor dedicado.

---

## 🌐 Publicar no GitHub Pages

1. Crie um repositório e envie o **conteúdo desta pasta** (o `index.html` precisa ficar na raiz do repo).
2. No GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. Em ~1 min o site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`. Mande esse link pros amigos.

Não precisa de build, Node, ngrok nem servidor próprio. As conexões de jogo são peer-to-peer (WebRTC via PeerJS); o servidor público do PeerJS só faz o "aperto de mão" inicial.

> Depois de atualizar arquivos, aumente o `?v=` no `index.html` (CSS/JS) pra ninguém ficar com cache antigo.

## 🎨 Temas de carta

Cada tema é uma pasta em `assets/cards/<tema>/` com 5 arquivos `.webp` de mesmo nome. Pra adicionar um:
crie a pasta, coloque as 5 imagens (~400×590 px) e registre em `CARD_THEMES` no `assets/js/deck.js`.
A escolha fica no `localStorage` (`CardTheme.set('animais')`); o seletor na interface ainda não existe.

## 🧪 Testar local

Rode `Start_Game.bat` (ou `python -m http.server 8000` nesta pasta) e abra http://localhost:8000.
Abra **duas abas**: numa **Criar Sala**, na outra **Entrar em Sala** com o código.

---

## 🗂️ Estrutura do projeto

```
coup-online/
├── index.html              # Página principal com todas as telas
├── README.md               # Este arquivo
└── assets/
    ├── css/
    │   └── style.css       # Estilos customizados (complementa o Tailwind CDN)
    ├── js/
    │   ├── main.js         # Ponto de entrada, wiring de eventos
    │   ├── game.js         # Lógica do Coup (Fase 3)
    │   ├── deck.js         # Baralho e personagens
    │   ├── ui.js           # Renderização de telas + animações
    │   ├── peer.js         # Conexão PeerJS (host + client)
    │   └── sounds.js       # Áudio procedural via Web Audio API (Fase 4)
    └── cards/              # Temas de carta (uma pasta por tema)
        ├── padrao/         # tema padrão (5 .webp: duque, assassino, capitao, embaixador, condessa)
        └── animais/        # tema alternativo
```

---

## 📋 Status atual

✅ **Fase 1 — Esqueleto:** concluída  
✅ **Fase 2 — Conexão PeerJS:** concluída (host + client + lobby)  
✅ **Fase 3 — Lógica do jogo:** concluída (todas as ações, contestação, bloqueio, vitória)  
✅ **Fase 4 — Experiência:** concluída (sons, animações, timer opcional, feedback)  
✅ **Fase 5 — Arte (imagens das 5 cartas):** concluída (avatares e tema opcional podem vir depois)

### Novidades da Fase 5
- 🎨 **Imagens reais das 5 cartas** — duque, assassino, capitão, embaixador e condessa, carregadas via `background-image` (cover + position center) em `.card-placeholder.has-image`
- 🃏 **Verso listrado** — mantido o padrão CSS 45° como verso das cartas (sem arquivo próprio)
- 🔄 **Compatibilidade** — flip 3D, shake e glow da Fase 4 continuam funcionando sobre as imagens
- 🏷️ **Label nos modais de seleção** — nome do personagem aparece sobre a imagem nos modais de perda/troca pra facilitar escolha

### Novidades da Fase 4
- 🔊 **Sons procedurais via Web Audio API** — sem arquivos: coin/flip/challenge/block/eliminate/victory/alert
- 🔇 **Toggle de som** no canto superior direito da tela de jogo (persiste no localStorage)
- ⏱️ **Timer opcional por jogada** — configurável no lobby pelo host (10–120s), com barra visual
- ✨ **Animações CSS** — flip 3D na carta revelada, pulso na moeda ao ganhar, shake na perda, glow no turno atual
- 🎨 **Log colorido** — contestações em amarelo, bloqueios em azul, eliminações/vitórias em vermelho
- 🎯 **Feedback de botão** — estados hover, active e focus-visible pra desktop e mobile

### O que já funciona (Fase 3)
- Sistema de turnos rotativo
- 7 ações implementadas: Renda, Ajuda Externa, Golpe, Imposto (Duque), Assassinar (Assassino), Roubar (Capitão), Trocar (Embaixador)
- Sistema completo de contestação — quem mente perde influência; quem contesta errado perde influência + ator troca a carta
- Sistema de bloqueio — Duque bloqueia Ajuda Externa; Condessa bloqueia Assassinato; Capitão/Embaixador bloqueiam Roubo
- Contestação de bloqueios (blefar no bloqueio também tem consequência)
- Regra dos 10+ moedas → Golpe obrigatório
- Embaixador: modal com 4 cartas pra escolher 2
- Perda de influência com modal de seleção
- Detecção automática de eliminação e vitória
- Log de eventos narrando tudo em português

Veja o arquivo `../PLANO_COUP.md` para o checklist completo.

---

## 🐛 Problemas comuns

**"peer-unavailable" ao tentar entrar numa sala**  
→ O host precisa estar com a sala aberta e a aba em primeiro plano.

**PeerJS não conecta (preso em "conectando...")**  
→ Pode ser NAT restritivo. Testar em outra rede ou usar um TURN server (tema de fase futura).

**Botões não funcionam no celular**  
→ Verifique se o navegador está atualizado. Testado em Chrome Android e Safari iOS.

**"A partida já começou" / "Sala cheia"**  
→ A sala não aceita entrada durante a partida nem acima de 6 jogadores.

**Alguém saiu no meio da partida**  
→ Quem sai (ou fica 90s offline) é eliminado e o jogo segue. Quem só atualiza a página tem 90s pra voltar com cartas e moedas intactas. Se o **host** fechar/atualizar a aba, a sala acaba.

---

*Stack: HTML + CSS + JS puro · PeerJS · Tailwind CDN · GitHub Pages*
