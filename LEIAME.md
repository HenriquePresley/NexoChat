# NexoChat

Central de atendimento para provedores de internet pelo WhatsApp, com IA (Gemini, ChatGPT ou Claude), integração com o SGP, atendentes, setores,
relatórios, pesquisa de satisfação, respostas rápidas, etiquetas e anotações.

> ⚠️ **WhatsApp por QR Code é uma conexão não oficial.** O WhatsApp pode bloquear números que usam esse
> tipo de conexão. Teste com um chip secundário. Para produção, o caminho seguro é a API oficial da Meta.

## O que o sistema faz
- **WhatsApp:** recebe e envia texto, fotos, vídeos, áudios e documentos (QR Code em *Canais e SGP*).
- **IA (Gemini por padrão):** responde sozinha os clientes novos, entende fotos e áudios (transcreve), e usa o SGP para:
  consultar o cliente pelo CPF, ver se a conexão está online ou offline, enviar faturas em aberto (valor, vencimento,
  Pix copia e cola e linha digitável), transferir para um setor e finalizar.
  Em suporte técnico ela só orienta o básico (reiniciar o roteador, foto das luzes) e passa para o Suporte; quem abre chamado é o atendente.
  A IA **não** faz liberação em confiança: ela avisa que vai passar para o Financeiro e transfere. Só o atendente libera, pelo painel.
- **Atendentes e setores:** cada pessoa tem login. Filas *Automação*, *Espera* (aguardando atendente) e *Andamento*.
  Assumir, transferir (para o setor ou para uma pessoa), devolver para a IA e finalizar.
- **Quem vê o quê:** administradores veem todas as conversas. Uma conversa assumida some para os outros atendentes e só aparece
  para quem assumiu; na fila *Espera* de um setor, só para quem é daquele setor. Conversas com a IA ficam só em *Automação*.
  Conversas finalizadas aparecem só para quem atendeu. Quando o cliente volta, quem estiver atendendo vê os atendimentos
  anteriores em *Painel do cliente › Histórico* (ou no botão "Ver atendimentos anteriores" no topo da conversa).
- **Painel do cliente:** busca no SGP, contrato, situação, faturas com botão "Enviar ao cliente", liberação em confiança,
  abertura de chamado, etiquetas, anotações internas e linha do tempo do atendimento.
- **Relatórios:** finalizados por dia, por atendente e por setor, tempo médio, 1ª resposta e % resolvido pela IA.
- **CSAT:** ao finalizar, o cliente recebe "de 1 a 5"; a nota aparece em *Satisfação*.
- **O que a IA sabe (Prompts da IA):** planos e produtos (com preço), perguntas frequentes e regras de "sempre" e "nunca".
  Em *Ensinar de uma vez* dá para colar um texto grande (ou mandar PDF/foto da tabela de preços): a IA organiza tudo
  e mostra o que vai mudar antes de aplicar. A IA usa na próxima resposta, sem reiniciar. O quadro *Conversar com a IA* testa sem mandar nada para o WhatsApp.
- **Área de atendimento:** em *Prompts da IA › Área de atendimento* ficam as cidades atendidas e os bairros sem cobertura.
  A IA segue essa lista acima do texto do prompt.
- **Comprovantes:** quando o cliente manda foto, print ou PDF de pagamento, a IA lê o valor, a data e a forma (Pix, boleto...),
  confirma o valor para o cliente e passa para o Financeiro. Na conversa aparece um cartão com o valor e se ele bate com alguma fatura
  em aberto no SGP. A IA não confirma o pagamento: quem confirma é o Financeiro. Usa o Gemini (liga/desliga em *Ajustes*).
- **Áudio:** o botão de microfone grava pelo navegador e o cliente recebe como mensagem de voz. Precisa de `https://` ou `localhost`.
- **Respostas rápidas:** digite `/` na conversa. Use `{cliente}` e `{atendente}` no texto.
- **Mensagens automáticas (Ajustes):** boas-vindas, aviso ao assumir, aviso de transferência, nome do atendente nas mensagens,
  palavra para o cliente encerrar (#sair), horário de atendimento com mensagem de ausência e setor de plantão,
  encerramento por inatividade, transcrição de áudios e "lembrar CPF".
- **Contatos:** editar o nome do contato (lápis ao lado do nome) e bloquear/desbloquear números.
- **Fila Finalizados:** busca no histórico e reabre um atendimento antigo.
- **Relatórios:** recorrência (quem resolveu, IA ou atendente, e quem voltou) e consumo da IA (respostas, áudios, tokens e custo).
- **Registros de acesso:** quem entrou, quando, de qual IP, e tentativas com senha errada.
- **Possíveis quedas:** quando vários clientes do mesmo bairro (bairro do cadastro no SGP) dizem que estão sem internet em pouco tempo
  (padrão: 3 clientes em 30 min), aparece um alerta vermelho na lista de atendimentos e no Dashboard, com a lista dos clientes.
  Ajuste a quantidade e o tempo em *Ajustes › Encerramento e recursos*.
- **Ligações:** quando o cliente liga no WhatsApp, a ligação é recusada com uma mensagem (dá para desligar em *Ajustes › Ligações*),
  fica anotada na conversa, a conversa sobe na lista com "tentou ligar" e o botão **Ligar** mostra o número para retornar.
  Com o **Telefone VoIP** ligado, o atendente liga e recebe chamadas de telefone direto no navegador (menu *Telefone*).

## Jeito fácil (Windows)
- **Ligar:** dê dois cliques em **`iniciar.bat`**. Na primeira vez ele instala tudo sozinho; depois só liga.
  O navegador abre no NexoChat, e se o sistema cair ele reinicia sozinho. Para desligar, feche a janela preta.
- **Atualizar:** baixe o zip novo (fica em Downloads) e dê dois cliques em **`atualizar.bat`**.
  Ele troca só os arquivos do sistema e mantém o seu `.env`, a pasta `dados` e o WhatsApp conectado.
  Depois feche a janela do NexoChat e abra o `iniciar.bat` de novo.
- **Ligar junto com o Windows:** aperte `Win + R`, digite `shell:startup` e Enter. Na pasta que abrir,
  clique com o botão direito › Novo › Atalho e aponte para o `iniciar.bat`.
- Linux/Mac: `./iniciar.sh`.

## Instalação
1. Instale o Node.js 20 ou mais novo (https://nodejs.org).
2. Na pasta do projeto: `npm install`
3. Copie `.env.exemplo` para `.env` e preencha (veja abaixo).
4. `npm start` e abra **http://localhost:3000**.
5. No primeiro acesso, crie o **administrador**. Depois cadastre os atendentes em *Atendentes*.
6. Em *Canais e SGP*, leia o QR Code com o WhatsApp (Dispositivos conectados › Conectar dispositivo).

### IA: Gemini (gratuito) e depois ChatGPT
- Gere a chave grátis em https://aistudio.google.com/apikey (conta Google) e coloque em `GEMINI_API_KEY=` no `.env`.
- Modelo padrão `gemini-3.5-flash-lite` (rápido e gratuito), com reserva `gemini-3.1-flash-lite`. Para respostas mais caprichadas, troque para `gemini-3.8-flash` em *Prompts da IA*.
- Se o Google estiver sobrecarregado, o sistema tenta de novo, depois usa o modelo reserva e, se nada responder, manda o cliente para a fila Espera com um aviso.
- **Atenção ao plano gratuito:** o Google pode usar as conversas enviadas para melhorar os produtos dele, e há limite de
  pedidos por dia. Para dados de clientes (CPF, endereço), o ideal é ativar o faturamento no Google AI Studio ou usar o ChatGPT.
- **Rodízio automático (gratuito):** o sistema reveza entre vários modelos do Gemini, cada um com a própria cota. Quando um
  congestiona ou bate o limite, ele "descansa" por um tempo e o próximo responde na hora. Se você colocar também a
  `GROQ_API_KEY` no `.env`, o Groq entra como último recurso. O estado do rodízio aparece em *Prompts da IA*.
- **Diagnóstico:** rode `npm run testar-ia`. Ele testa a chave e vários modelos e diz qual está respondendo agora e qual usar.
- **Gemini congestionado ("muita demanda")?** Use o **Groq**, também gratuito e muito rápido: crie a chave em https://console.groq.com/keys
  e no `.env` coloque `IA_PROVEDOR=groq` e `GROQ_API_KEY=...`. O Groq não enxerga fotos (a IA pede para o cliente descrever),
  mas transcreve áudios normalmente.
- **Para trocar para o ChatGPT:** no `.env`, mude `IA_PROVEDOR=openai`, preencha `OPENAI_API_KEY` e `IA_MODELO=gpt-5-mini`,
  e reinicie. Nada mais muda: prompt, ações do SGP e relatórios continuam iguais.
- Em *Prompts da IA* você ajusta o jeito de falar, os planos e as regras. As ações do SGP são ensinadas à IA automaticamente.

### Chaves das IAs (chaves.env, opcional)
Opcionalmente, as chaves do Gemini e do Groq podem ficar num arquivo `chaves.env` (na raiz ou em `src/`), que vale mais que o `.env`.
Esse arquivo **nunca** deve ir para o repositório (já está no `.gitignore`).

### SGP
1. No SGP: **Administração › Integrações › Tokens › Adicionar Token**. App: `chatbot`. Libere o IP do servidor do painel.
2. No `.env`: `SGP_URL`, `SGP_APP`, `SGP_TOKEN`. Reinicie.
3. Em *Canais e SGP*, use **Testar consulta** com um CPF. Ele mostra a resposta bruta do SGP.
   Se algum campo (nome, plano, situação, valor) não aparecer certo no painel, envie esse retorno
   (apagando dados pessoais) para ajustar a leitura — cada versão do SGP devolve nomes de campos um pouco diferentes.
4. Rotas usadas: `/api/ura/consultacliente/`, `/api/ura/titulos/`, `/api/ura/verificaacesso/` (conexão online/offline), `/api/ura/liberacaopromessa/` (só pelo atendente), `/api/ura/chamado/`.

### Telefone VoIP (opcional)
A conexão do WhatsApp por QR Code não transmite voz. Para falar por telefone no painel é preciso um PABX/operadora VoIP
que aceite **SIP por WebSocket seguro (WSS) com WebRTC** — por exemplo Asterisk, FreePBX ou Issabel com WebRTC ativado.
1. No PABX: crie um ramal para cada atendente com WebRTC ligado (FreePBX: *Enable WebRTC defaults* = Sim) e libere a porta WSS (geralmente 8089).
2. Em *Ajustes › Ligações*: ative o telefone e preencha o servidor (`wss://pabx.seudominio.com.br:8089/ws`), o domínio SIP, o DDD e como o PABX disca os números.
3. Em *Atendentes › Editar*: coloque o ramal e a senha do ramal de cada pessoa.
4. O navegador só libera o microfone em `https://` ou em `http://localhost`. Em outros computadores da rede, use o painel por HTTPS.
As ligações ficam anotadas na conversa do cliente (quem ligou, duração) e no histórico do Telefone (`dados/ligacoes.json`).

## Colocar na internet (VPS)
- Use HTTPS (Nginx ou Caddy) na frente da porta 3000.
- O `iniciar.bat` fecha um NexoChat que tenha ficado aberto (porta 3000 ocupada) e abre o painel no Google Chrome (se não houver Chrome, no navegador padrão).
- Para manter rodando: `npm i -g pm2 && pm2 start server.js --name atendimento && pm2 save`.
- Faça backup da pasta `dados/`.

## Onde ficam os dados (`dados/`)
- `sessao-whatsapp/` — sessão do WhatsApp (não compartilhe).
- `conversas.json` — conversas, etiquetas, notas e eventos.
- `atendimentos.jsonl` — um registro por atendimento finalizado (relatórios e CSAT).
- `usuarios.json` — atendentes (senhas guardadas com hash).
- `respostas.json`, `tags.json`, `config.json` — respostas rápidas, etiquetas, ajustes da IA e mensagens automáticas.
- `consumo.json`, `acessos.json` — consumo da IA por dia e registros de acesso.
- `ligacoes.json` — ligações do WhatsApp e do telefone VoIP.
- `midia/` — fotos, vídeos e arquivos.

## Limites desta versão
- Só conversas individuais (grupos são ignorados). Histórico antigo do celular não é importado.
- Ao reiniciar o servidor, os atendentes precisam entrar de novo.
- Privacidade: a IA só confirma o primeiro nome do titular, mas qualquer pessoa que souber um CPF consegue a 2ª via
  daquele contrato (como em outros robôs de provedor). Se quiser, dá para exigir que o telefone bata com o cadastro.
