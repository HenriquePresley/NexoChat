# NexoChat 💬

**Central de atendimento por WhatsApp para provedores de internet, com IA integrada ao SGP.**

A IA atende os clientes sozinha: identifica o cliente pelo CPF, vê se a conexão está online ou offline,
envia a 2ª via da fatura com Pix e transfere para o setor certo quando o assunto precisa de uma pessoa.
Os atendentes trabalham num painel web com filas, setores, etiquetas e relatórios.

🔗 **Demonstração ao vivo:** https:/HenriquePresley.github.io/nexochat/ *(dados fictícios, roda no navegador)*

> Projeto feito a pedido do dono de um provedor de internet onde trabalhei no suporte, desenvolvido em *vibe coding*
> com assistentes de IA (Claude e Codex). Eu defini as regras a partir da rotina real do suporte, testei e fui
> ajustando o comportamento. Deixei a empresa antes do lançamento, então nunca foi usado em produção. O nome e a
> identidade visual foram trocados, e todos os nomes, planos, preços e dados da demonstração são fictícios.

---

## O que ele faz

**Atendimento automático com IA**
- Responde clientes no WhatsApp em linguagem simples, entende **áudios** (transcreve) e **fotos**.
- Consulta o cliente no **SGP** pelo CPF/CNPJ, mostra a situação do contrato e o status da conexão.
- Envia faturas em aberto (valor, vencimento, **Pix copia e cola** e linha digitável).
- Lê **comprovantes de pagamento** (valor, data, forma) e confere com as faturas em aberto.
- No suporte técnico, orienta o básico (reiniciar o roteador, pedir foto das luzes do aparelho) e transfere.
- Regras de segurança no prompt: nunca promete o que não pode fazer, não informa senhas e não confirma pagamentos.
- Funciona com **Gemini** (gratuito), **ChatGPT** ou **Claude**, com rodízio automático entre modelos quando um congestiona.

**Painel dos atendentes**
- Login por atendente, setores (Suporte, Financeiro, Comercial) e filas *Automação*, *Espera* e *Andamento*.
- Assumir, transferir, devolver para a IA e finalizar; histórico do cliente, etiquetas e anotações internas.
- Respostas rápidas (`/`), mensagens automáticas, horário de atendimento e encerramento por inatividade.
- **Alerta de possível queda:** vários clientes do mesmo bairro sem internet em pouco tempo geram um aviso.
- Relatórios (tempo médio, 1ª resposta, % resolvido pela IA), **pesquisa de satisfação (CSAT)** e consumo da IA.
- Telefone **VoIP** opcional no navegador (SIP por WebSocket / WebRTC).

## Tecnologias

| Parte | Tecnologia |
|---|---|
| Servidor | Node.js 20+, Express, Socket.IO |
| WhatsApp | Baileys (conexão por QR Code) |
| IA | Google Gemini (API REST), OpenAI e Anthropic (SDKs oficiais), Groq como reserva |
| Sistema do provedor | API do SGP (`/api/ura/...`) |
| Painel | HTML, CSS e JavaScript puro (sem framework) |
| Telefone | JsSIP + gravação Opus |

## Como rodar

```bash
npm install
cp .env.exemplo .env   # preencha GEMINI_API_KEY (gratuita em https://aistudio.google.com/apikey)
npm start              # abre em http://localhost:3000
```

No primeiro acesso, crie o administrador. Em *Canais e SGP*, leia o QR Code com o WhatsApp.
O manual completo (SGP, VoIP, servidor na internet) está em [LEIAME.md](LEIAME.md).

Sem servidor nenhum, abrir `public/index.html` no navegador mostra o painel em **modo demonstração**.

## Estrutura

```
server.js            servidor, WhatsApp, filas e rotas da API
src/ia.js            conversa com a IA, rodízio de modelos e ações ([CONSULTAR_CPF], [ENVIAR_FATURA]...)
src/sgp.js           integração com o SGP
src/geral.js         mensagens automáticas, horário, planos e área de atendimento
prompt-padrao.txt    instruções da atendente virtual
public/index.html    painel dos atendentes (e modo demonstração)
docs/                cópia do painel publicada no GitHub Pages
```

## Avisos

- **WhatsApp por QR Code é uma conexão não oficial** e pode levar o número a ser bloqueado. Em produção, o caminho
  certo é a API oficial da Meta.
- Nunca suba o `.env`, o `chaves.env` ou a pasta `dados/` (já estão no `.gitignore`).
- No plano gratuito do Gemini, o Google pode usar as conversas para melhorar os produtos dele. Para dados reais de
  clientes, ative o faturamento ou use outro provedor.

## Autor

**Henrique Presley** — Técnico em Redes, estudante de Análise e Desenvolvimento de Sistemas.
[LinkedIn](https://www.linkedin.com/in/henrique-p-171b33256/)
