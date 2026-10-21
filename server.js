// NexoChat (Provedor Exemplo) — WhatsApp por QR Code (Baileys) + IA (ChatGPT ou Claude) + SGP
// ATENÇÃO: conexão de WhatsApp NÃO oficial. Use para testes com um número secundário.
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import multer from 'multer';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  downloadMediaMessage, jidNormalizedUser, Browsers, isJidGroup, isJidBroadcast, isJidNewsletter
} from '@whiskeysockets/baileys';

import { ENV_ARQUIVO, CHAVES_ARQUIVO, ENV_CHAVES_GRAVADAS, ROOT, PORT, AUTH_DIR, MEDIA_DIR, MAX_MB, IA_ESPERA_MS, TZ, START, logger, SETORES, SETOR_POR_NOME } from './src/config.js';
import { conversas, respostas, tags, atendimentos, consumo, acessos, ligacoes } from './src/store.js';
import { geral, geralPadrao, salvarGeral, dentroDoHorario, preencher, estaBloqueado } from './src/geral.js';
import * as auth from './src/auth.js';
import * as sgp from './src/sgp.js';
import { verificarChaves, lerJson, ia, iaPronta, cfg, salvarCfg, PROMPT_PADRAO, NOME_PROVEDOR, VAR_CHAVE, explicarErro, ACEITA_IMAGEM, estadoRodizio } from './src/ia.js';

const db = conversas.data;
let ultimoTesteChaves = [];
// Quem já atendeu cada cliente (para mostrar as conversas finalizadas só para quem atendeu)
const atendeu = new Map(); // jid -> Set(ids de atendentes)
const marcarAtendeu = (jid, uid) => { if (!jid || !uid) return; if (!atendeu.has(jid)) atendeu.set(jid, new Set()); atendeu.get(jid).add(uid); };
for (const r of atendimentos.all(0)) marcarAtendeu(r.jid, r.atendenteId);
const save = () => conversas.save();
let io;

/* ================================================================== */
/* Conversas e atendimentos                                           */
/* ================================================================== */
const agora = () => Date.now();
const novoProtocolo = () => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${crypto.randomInt(100, 999)}`;
};

function chatOf(jid, extra = {}) {
  let c = db.chats[jid];
  if (!c) {
    c = db.chats[jid] = { jid, name: '', phone: '', unread: 0, ia: false, status: 'finalizado', sector: null, assumed: null, assumedId: null,
      msgs: [], tags: [], notas: [], eventos: [], sgp: null };
  }
  c.tags ||= []; c.notas ||= []; c.eventos ||= [];
  if (extra.name && !c.name) c.name = extra.name;
  if (extra.phone) c.phone = extra.phone;
  return c;
}
function abrirAtendimento(c, ts = agora()) {
  c.ia = iaPronta(); c.status = c.ia ? 'automacao' : 'espera';
  c.sector = null; c.assumed = null; c.assumedId = null; c.csat = null;
  c.protocolo = novoProtocolo(); c.inicio = ts; c.primeiraResposta = null; c.teveHumano = false; c.eventos = []; c.ausenciaEnviada = false; c.motivo = null; c.humor = null;
  if (!geral.lembrarCpf) c.sgp = null;
  evento(c, 'abriu', c.ia ? 'IA' : 'fila');
}
function evento(c, tipo, por, extra = {}) { c.eventos.push({ ts: agora(), tipo, por, ...extra }); }
function nota(c, texto, opts = {}) {
  const m = { id: 'n' + crypto.randomBytes(6).toString('hex'), sys: true, ts: agora(), type: 'text', text: texto, paraIA: !!opts.paraIA, papel: opts.papel || 'user', ...(opts.tipo ? { tipo: opts.tipo } : {}) };
  c.msgs.push(m); save();
  emitirChat(c, 'wa:message', { chat: summary(c), msg: m });
  return m;
}
export const MOTIVOS = { fatura: 'Fatura / 2ª via', sem_internet: 'Sem internet', lentidao: 'Lentidão', comprovante: 'Comprovante / já paguei', contratar: 'Contratar / planos',
  cancelamento: 'Cancelamento', mudanca: 'Mudança (endereço, plano, vencimento)', quitacao: 'Declaração de quitação', suporte: 'Suporte (outros)', outro: 'Outro' };
function summary(c) {
  const last = [...c.msgs].reverse().find(m => !m.sys) || null;
  // cliente esperando resposta desde a última mensagem dele que ainda não foi respondida
  const evEspera = c.status === 'espera' ? [...(c.eventos || [])].reverse().find(e => ['transferiu', 'abriu', 'ia_falhou'].includes(e.tipo)) : null;
  const aguardandoDesde = c.status === 'espera' ? (evEspera?.ts || last?.ts || null)
    : c.status === 'andamento' && last && !last.fromMe ? last.ts : null;
  return { jid: c.jid, name: c.name, phone: c.phone, unread: c.unread, ia: !!c.ia, status: c.status || 'finalizado',
    sector: c.sector || null, assumed: c.assumed || null, assumedId: c.assumedId || null, protocolo: c.protocolo || null,
    inicio: c.inicio || null, ligou: c.ligou && agora() - c.ligou < 3600e3 ? c.ligou : null, tags: c.tags || [], motivo: c.motivo || null, humor: c.humor || null, aguardandoDesde, cliente: c.sgp?.contratos?.find(x => x.contrato === c.sgp.contrato) || c.sgp?.contratos?.[0] || null,
    last };
}
function pushChat(c) { save(); emitirChat(c, 'wa:chat', summary(c)); }
// Quem vê cada conversa: administradores veem tudo. Conversa assumida só aparece para quem assumiu.
// Na fila Espera de um setor, só para quem é daquele setor. Automação (IA) aparece para todos.
// Finalizadas: só para quem atendeu o cliente. O histórico anterior aparece para quem está atendendo agora.
function podeVer(u, c) {
  if (!u) return false;
  if (u.papel === 'admin') return true;
  if (c.status === 'automacao') return true;
  if (c.status === 'finalizado') return c.assumedId === u.id || !!atendeu.get(c.jid)?.has(u.id);
  if (c.assumedId) return c.assumedId === u.id;
  if (c.status === 'espera' && c.sector) return !(u.setores || []).length || u.setores.includes(c.sector);
  return true;
}
function emitirChat(c, ev, payload) {
  if (!io) return;
  for (const s of io.sockets.sockets.values()) {
    const u = auth.porId(s.data.uid);
    if (podeVer(u, c)) s.emit(ev, payload); else s.emit('conversa:oculta', { jid: c.jid, com: c.assumed || null });
  }
}

const clienteAtual = c => c.sgp?.contratos?.find(x => x.contrato === c.sgp.contrato) || (c.sgp?.contratos?.length === 1 ? c.sgp.contratos[0] : null);
// Texto corrido da conversa (para resumo, classificação e sugestão)
function transcricao(c, n = 30) {
  return c.msgs.filter(m => !m.auto && (!m.sys || m.interno)).slice(-n).map(m => {
    const quem = m.interno ? `[interno] ${m.autor}` : m.fromMe ? (m.ia ? 'IA' : (m.agent || 'Atendente')) : 'Cliente';
    const conteudo = m.transcricao ? `(áudio) ${m.transcricao}` : m.text || { image: '(foto)', video: '(vídeo)', audio: '(áudio)', document: `(arquivo ${m.fileName || ''})` }[m.type] || '';
    return `${quem}: ${String(conteudo).slice(0, 500)}`;
  }).join('\n');
}
async function perguntarIA(instrucao, texto, maxTokens = 400) {
  if (!ia.gerar) throw erro(`Configure a chave ${VAR_CHAVE} no .env para usar a IA.`, 409);
  return String(await ia.gerar({ system: instrucao, maxTokens, messages: [{ role: 'user', content: [{ type: 'text', text: texto || '(conversa vazia)' }] }] }) || '').trim();
}
// Classifica o motivo depois de finalizar, se a IA não marcou durante a conversa
async function classificarDepois(protocolo, texto, info = null) {
  if (!ia.gerar || !texto) return;
  try {
    const r = await perguntarIA(`Classifique o motivo deste atendimento de provedor de internet. Responda só com UMA destas palavras: ${Object.keys(MOTIVOS).join(', ')}.`, texto, 20);
    const m = (r.toLowerCase().match(new RegExp(Object.keys(MOTIVOS).join('|'))) || [])[0];
    if (m) atendimentos.update(protocolo, { motivo: m });
    if (m === 'sem_internet' && info) { semInternetRecentes.push(info); verificarQuedas(); }
  } catch (e) { logger.debug(e, 'classificação falhou'); }
}
async function gerarResumo(c) {
  const r = await perguntarIA('Você resume atendimentos de um provedor de internet para o próximo atendente. Escreva em português, no máximo 3 linhas: quem é o cliente (primeiro nome e contrato se houver), o problema, o que já foi feito e o que falta. Sem saudação.', transcricao(c, 40), 300);
  if (r) nota(c, r, { tipo: 'resumo' });
  return r;
}

async function finalizar(c, por, porId = null, opts = {}) {
  if (c.status === 'finalizado') return;
  const fim = agora();
  if (c.teveHumano) marcarAtendeu(c.jid, c.assumedId || porId);
  atendimentos.add({
    protocolo: c.protocolo, jid: c.jid, nome: c.name, telefone: c.phone, inicio: c.inicio || fim, fim,
    setor: c.sector, atendente: c.teveHumano ? (c.assumed || por) : null, atendenteId: c.teveHumano ? (c.assumedId || porId) : null,
    porIA: !c.teveHumano, primeiraResposta: c.primeiraResposta, tma: fim - (c.inicio || fim), csat: null,
    contrato: c.sgp?.contrato || null, motivo: c.motivo || null, humor: c.humor || null,
    bairro: clienteAtual(c)?.bairro || null, cidade: clienteAtual(c)?.cidade || null
  });
  const cl = clienteAtual(c);
  if (c.motivo === 'sem_internet') semInternetRecentes.push({ jid: c.jid, nome: cl?.nome || c.name, bairro: cl?.bairro, cidade: cl?.cidade, ts: c.motivoTs || fim });
  if (!c.motivo) classificarDepois(c.protocolo, transcricao(c, 20), { jid: c.jid, nome: cl?.nome || c.name, bairro: cl?.bairro, cidade: cl?.cidade, ts: fim });
  evento(c, 'finalizou', por);
  c.status = 'finalizado'; c.ia = false; c.unread = 0;
  clearTimeout(iaTimers.get(c.jid));
  if (cfg.csat && !opts.semCsat && state.status === 'conectado') {
    try {
      const pergunta = 'Seu atendimento foi finalizado. ✅\nDe *1 a 5*, quanto você dá para o nosso atendimento? (5 = excelente)';
      await enviar(c.jid, { text: pergunta }, { type: 'text', text: pergunta, auto: true });
      c.csat = { protocolo: c.protocolo, ate: agora() + 24 * 3600e3 };
    } catch (e) { logger.warn(e, 'falha ao enviar CSAT'); }
  }
  pushChat(c);
}

// Envia uma mensagem automática (boas-vindas, ausência, aviso...). Não conta como resposta de atendente.
async function auto(c, texto, por = null) {
  if (!texto || state.status !== 'conectado') return;
  const t = preencher(texto, c, por || '');
  try { await enviar(c.jid, { text: t }, { type: 'text', text: t, auto: true, agent: por || null }); } catch (e) { logger.warn(e, 'falha em mensagem automática'); }
}
// Fora do horário: avisa o cliente uma vez por atendimento
async function avisarAusencia(c) {
  if (c.ausenciaEnviada) return;
  c.ausenciaEnviada = true;
  await auto(c, geral.horario.ausencia);
}

/* ================================================================== */
/* WhatsApp (Baileys)                                                 */
/* ================================================================== */
let sock = null;
let state = { status: 'iniciando', qr: null, me: null };
const nossosIds = new Set();
function setState(patch) { state = { ...state, ...patch }; io?.emit('wa:status', state); }
const phoneFromJid = jid => (jid || '').split('@')[0].split(':')[0];
const novoId = () => '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();

function typeAndBody(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.documentWithCaptionMessage?.message || msg;
  if (inner.conversation) return { type: 'text', text: inner.conversation };
  if (inner.extendedTextMessage) return { type: 'text', text: inner.extendedTextMessage.text };
  if (inner.imageMessage) return { type: 'image', text: inner.imageMessage.caption || '', mime: inner.imageMessage.mimetype };
  if (inner.videoMessage) return { type: 'video', text: inner.videoMessage.caption || '', mime: inner.videoMessage.mimetype };
  if (inner.audioMessage) return { type: 'audio', text: '', mime: inner.audioMessage.mimetype };
  if (inner.stickerMessage) return { type: 'image', text: '', mime: inner.stickerMessage.mimetype || 'image/webp' };
  if (inner.documentMessage) return { type: 'document', text: inner.documentMessage.caption || '', mime: inner.documentMessage.mimetype, fileName: inner.documentMessage.fileName };
  if (inner.buttonsResponseMessage) return { type: 'text', text: inner.buttonsResponseMessage.selectedDisplayText || '' };
  if (inner.listResponseMessage) return { type: 'text', text: inner.listResponseMessage.title || '' };
  if (inner.locationMessage) return { type: 'text', text: `📍 Localização: https://maps.google.com/?q=${inner.locationMessage.degreesLatitude},${inner.locationMessage.degreesLongitude}` };
  if (inner.contactMessage) return { type: 'text', text: `👤 Contato: ${inner.contactMessage.displayName}` };
  return null;
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg; codecs=opus': 'ogg', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf' };

async function handleIncoming(m) {
  const jid = m.key.remoteJid;
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
  const id = m.key.id;
  if (m.key.fromMe && nossosIds.has(id)) return;
  const parsed = typeAndBody(m);
  if (!parsed) return;
  const altJid = m.key.remoteJidAlt || m.key.senderPn || '';
  const numero = phoneFromJid(altJid.includes('@s.whatsapp.net') ? altJid : jid);
  if (!m.key.fromMe && (estaBloqueado(numero) || estaBloqueado(phoneFromJid(jid)))) return; // contato bloqueado
  const c = chatOf(jid, { name: m.key.fromMe ? '' : m.pushName, phone: phoneFromJid(altJid.includes('@s.whatsapp.net') ? altJid : jid) });
  if (c.msgs.some(x => x.id === id)) return;

  const ts = Number(m.messageTimestamp) * 1000 || agora();
  const nova = ts >= START - 60000; // ignora histórico antigo sincronizado na conexão
  const rec = { id, fromMe: !!m.key.fromMe, type: parsed.type, text: parsed.text || '', ts, mime: parsed.mime || null, fileName: parsed.fileName || null, media: null };
  if (rec.fromMe) rec.agent = 'Celular';
  if (['image', 'video', 'audio', 'document'].includes(parsed.type)) {
    try {
      const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const ext = EXT[parsed.mime] || (parsed.mime || 'bin').split('/')[1]?.split(';')[0] || 'bin';
      const file = `${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
      rec.media = `/midia/${file}`;
    } catch (e) { logger.warn(e, 'falha ao baixar mídia'); rec.text ||= '[mídia não pôde ser baixada]'; }
  }

  // Resposta da pesquisa de satisfação
  if (!rec.fromMe && nova && c.status === 'finalizado' && c.csat && agora() < c.csat.ate) {
    const n = (rec.text || '').trim().match(/^([1-5])(?:\s|$|️⃣|⭐)/u) || (rec.text || '').trim().match(/^([1-5])$/);
    const prot = c.csat.protocolo; c.csat = null;
    if (n && rec.type === 'text') {
      // A nota fica só no relatório de satisfação (visível para administradores).
      // Não entra na conversa e não gera aviso para os atendentes.
      atendimentos.update(prot, { csat: Number(n[1]) });
      save();
      await enviar(jid, { text: 'Obrigado pela avaliação! 💙' }, { type: 'text', text: 'Obrigado pela avaliação! 💙', auto: true, oculto: true }).catch(() => {});
      return;
    }
  }

  // Cliente pediu para encerrar (#sair)
  const palavra = (geral.sair.palavra || '').trim().toLowerCase();
  if (!rec.fromMe && nova && palavra && rec.type === 'text' && rec.text.trim().toLowerCase() === palavra && c.status !== 'finalizado') {
    c.msgs.push(rec); save(); emitirChat(c, 'wa:message', { chat: summary(c), msg: rec });
    await auto(c, geral.sair.texto);
    nota(c, 'Cliente encerrou com ' + geral.sair.palavra);
    await finalizar(c, 'Cliente', null, { semCsat: true });
    return;
  }

  const abriu = !rec.fromMe && nova && c.status === 'finalizado';
  if (abriu) abrirAtendimento(c, ts);
  c.msgs.push(rec);
  if (c.msgs.length > 600) c.msgs.splice(0, c.msgs.length - 600);

  // Transcrição de áudio (para o atendente ler e para a IA entender)
  if (rec.type === 'audio' && rec.media && !rec.fromMe && geral.transcrever && ia.transcrever && nova) {
    try {
      const buf = fs.readFileSync(path.join(MEDIA_DIR, path.basename(rec.media)));
      if (buf.length < 15 * 1024 * 1024) rec.transcricao = (await ia.transcrever(buf, rec.mime || 'audio/ogg')).slice(0, 4000);
    } catch (e) { logger.warn(e, 'falha ao transcrever áudio'); }
  }

  if (!rec.fromMe) {
    c.unread++;
    if (nova && !c.motivo && c.status !== 'finalizado' && PALAVRAS_SEM_INTERNET.test(rec.text || rec.transcricao || '')) definirMotivo(c, 'sem_internet');
  }
  else if (nova && c.status !== 'finalizado') {
    if (c.primeiraResposta == null && c.inicio) c.primeiraResposta = ts - c.inicio;
    if (c.ia) { // alguém respondeu direto pelo celular: a IA sai da conversa
      c.ia = false; c.status = 'andamento'; c.assumed = 'Celular'; c.teveHumano = true; clearTimeout(iaTimers.get(jid));
      evento(c, 'assumiu', 'Celular');
    }
  }
  save();
  emitirChat(c, 'wa:message', { chat: summary(c), msg: rec });
  if (abriu) {
    if (geral.boasVindas.ativo) await auto(c, geral.boasVindas.texto);
    if (!c.ia && !dentroDoHorario()) await avisarAusencia(c);
  }
  if (!rec.fromMe && nova && c.status !== 'finalizado' && geral.lerAnexos !== false) await lerAnexo(c, rec);
  if (!rec.fromMe && nova && c.ia && iaPronta()) agendarIA(jid);
}

// Lê fotos e PDFs do cliente: reconhece comprovante de pagamento (valor, data, forma) e descreve as outras fotos
async function lerAnexo(c, rec) {
  const ehImg = rec.type === 'image' && IMG_OK.includes(rec.mime);
  const ehPdf = rec.type === 'document' && /pdf/i.test(String(rec.mime || '') + String(rec.fileName || ''));
  if (!rec.media || !(ehImg || ehPdf) || !ia.lerAnexo) return;
  try {
    const buf = fs.readFileSync(path.join(MEDIA_DIR, path.basename(rec.media)));
    if (buf.length > 8 * 1024 * 1024) return;
    const l = await ia.lerAnexo(buf, ehPdf ? 'application/pdf' : rec.mime);
    if (!l) return;
    rec.leitura = l;
    if (l.comprovante) {
      if (!c.motivo || c.motivo === 'fatura') definirMotivo(c, 'comprovante');
      l.confere = await conferirComFaturas(c, l.valor);
    }
    save();
    emitirChat(c, 'msg:atualizada', { jid: c.jid, msg: rec });
    pushChat(c);
  } catch (e) { logger.warn({ erro: e.message }, 'falha ao ler foto/PDF'); }
}
// Compara o valor do comprovante com as faturas em aberto (informação só para a equipe; quem confirma é o Financeiro)
async function conferirComFaturas(c, valor) {
  const ct = contratoAtual(c);
  if (!valor || !ct || !sgp.sgpAtivo()) return null;
  try {
    const ts = await sgp.titulos(ct);
    if (!ts.length) return 'Não há faturas em aberto no SGP para o contrato ' + ct + '.';
    const igual = ts.find(t => t.valor != null && Math.abs(t.valor - valor) < 0.02);
    if (igual) return `Valor igual ao da fatura de ${igual.vencimento} (${sgp.reais(igual.valor)}).`;
    const total = ts.reduce((a, t) => a + (t.valor || 0), 0);
    if (ts.length > 1 && Math.abs(total - valor) < 0.02) return `Valor igual à soma das ${ts.length} faturas em aberto.`;
    return 'Valor diferente das faturas em aberto: ' + ts.map(t => `${t.vencimento} ${sgp.reais(t.valor)}`).join('; ') + '.';
  } catch { return null; }
}
const descreverLeitura = (l, pdf) => {
  if (!l) return '';
  const qual = pdf ? 'Arquivo PDF enviado pelo cliente' : 'Imagem enviada pelo cliente';
  const forma = { pix: 'Pix', boleto: 'boleto', transferencia: 'transferência', cartao: 'cartão', deposito: 'depósito' }[l.forma] || '';
  if (l.comprovante) return ` [${qual} — COMPROVANTE DE PAGAMENTO: ${[forma, l.valor ? 'de ' + sgp.reais(l.valor) : 'valor não identificado', l.data ? 'em ' + l.data + (l.hora ? ' ' + l.hora : '') : '', l.recebedor ? 'para ' + l.recebedor : ''].filter(Boolean).join(' ')}${l.agendado ? ' — É SÓ UM AGENDAMENTO (ainda não pago)' : ''}]`;
  if (l.cobranca) return ` [${qual} — DOCUMENTO DE COBRANÇA (boleto/fatura que o cliente enviou): ${[l.valor ? sgp.reais(l.valor) : '', l.vencimento ? 'vencimento ' + l.vencimento : '', l.descricao].filter(Boolean).join(' · ')}]`;
  return l.descricao ? ` [${qual} — ${pdf ? 'ARQUIVO' : 'FOTO'}: ${l.descricao}]` : '';
};

async function startWA() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  sock = makeWASocket({ auth: authState, logger, version, browser: Browsers.ubuntu('NexoChat'), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) setState({ status: 'aguardando_qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) });
    if (u.connection === 'open') {
      const me = sock.user ? { id: jidNormalizedUser(sock.user.id), name: sock.user.name || '', phone: phoneFromJid(sock.user.id) } : null;
      setState({ status: 'conectado', qr: null, me });
      console.log('✅ WhatsApp conectado:', me?.phone);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setState({ status: 'desconectado', qr: null, me: null });
      } else setState({ status: 'reconectando', qr: null });
      setTimeout(startWA, code === DisconnectReason.loggedOut ? 1000 : 3000);
    }
  });
  // Ligações no WhatsApp: a conexão por QR Code não transmite voz, então recusa e avisa o cliente
  sock.ev.on('call', chamadas => aoLigar(chamadas).catch(e => logger.error(e, 'ligação do WhatsApp')));
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) await handleIncoming(m).catch(e => logger.error(e));
  });
}

async function aoLigar(chamadas) {
    for (const ch of chamadas) {
      if (ch.status !== 'offer' || ch.isGroup) continue;
      const jid = ch.chatId || ch.from;
      const numero = phoneFromJid(ch.callerPn || (jid.includes('@s.whatsapp.net') ? jid : ''));
      if (estaBloqueado(numero)) { try { await sock.rejectCall(ch.id, ch.from); } catch {} continue; }
      const c = db.chats[jid] || (numero && conversaPorNumero(numero)) || chatOf(jid, { phone: numero || undefined });
      if (c.status === 'finalizado') abrirAtendimento(c);
      c.ligou = agora();
      nota(c, `📞 Cliente tentou ligar pelo WhatsApp${ch.isVideo ? ' (vídeo)' : ''}${geral.chamadasWhatsApp.recusar ? ' · ligação recusada automaticamente' : ''}`);
      ligacoes.data.lista.push({ ts: agora(), canal: 'whatsapp', direcao: 'entrada', numero, jid: c.jid, status: geral.chamadasWhatsApp.recusar ? 'recusada' : 'perdida' });
      ligacoes.save();
      pushChat(c);
      emitirChat(c, 'ligacao:whatsapp', { jid: c.jid, nome: c.name || numero });
      if (geral.chamadasWhatsApp.recusar) {
        try { await sock.rejectCall(ch.id, ch.from); } catch (e) { logger.warn(e, 'falha ao recusar ligação'); }
        await auto(c, geral.chamadasWhatsApp.texto);
      }
    }
}

async function enviar(jid, content, rec) {
  if (!sock || state.status !== 'conectado') throw new Error('WhatsApp não está conectado.');
  const id = novoId();
  nossosIds.add(id);
  if (nossosIds.size > 5000) nossosIds.delete(nossosIds.values().next().value);
  await sock.sendMessage(jid, content, { messageId: id });
  const c = chatOf(jid, { phone: jid.endsWith('@s.whatsapp.net') ? phoneFromJid(jid) : '' });
  if (rec.oculto) return { chat: summary(chatOf(jid)), msg: null };
  const msg = { id, fromMe: true, ts: agora(), ...rec };
  if (!rec.auto) c.ligou = null;
  if (c.status !== 'finalizado' && c.primeiraResposta == null && c.inicio && !rec.auto) c.primeiraResposta = msg.ts - c.inicio;
  c.msgs.push(msg);
  save();
  emitirChat(c, 'wa:message', { chat: summary(c), msg });
  return { chat: summary(c), msg };
}

/* ================================================================== */
/* IA com ações (consultar CPF, faturas, liberação, chamado...)       */
/* ================================================================== */
const iaTimers = new Map();
const iaOcupada = new Set();
function agendarIA(jid) {
  clearTimeout(iaTimers.get(jid));
  iaTimers.set(jid, setTimeout(() => responderIA(jid).catch(async e => {
    logger.error(e, 'erro na IA');
    const motivo = explicarErro(e);
    io.emit('ia:erro', { jid, erro: motivo });
    // IA indisponível: o cliente não fica sem resposta, vai para a fila de atendentes
    const c = db.chats[jid];
    if (c && c.ia) {
      c.ia = false; c.status = 'espera'; evento(c, 'ia_falhou', 'Sistema');
      nota(c, `IA não conseguiu responder: ${motivo} O atendimento foi para a fila Espera.`);
      pushChat(c);
      if (dentroDoHorario()) await auto(c, 'Um instante, por favor! Já vou te atender. 🙂');
      else await avisarAusencia(c);
    }
  }), IA_ESPERA_MS));
}

function regrasAcoes() {
  const base = `
AÇÕES DO SISTEMA
Você pode pedir ações ao sistema escrevendo um código entre colchetes, sozinho na última linha da sua resposta. O código nunca aparece para o cliente. Depois de uma ação de consulta, o sistema devolve o resultado numa mensagem que começa com [SISTEMA]; use esse resultado para continuar a conversa.
- [TRANSFERIR:suporte] / [TRANSFERIR:financeiro] / [TRANSFERIR:comercial] — passa para um atendente humano do setor. Avise o cliente antes. Depois disso você para de responder.
- [FINALIZAR] — encerra o atendimento quando o problema foi resolvido e o cliente confirmou que não precisa de mais nada.
Marcações internas (o cliente nunca vê; podem ir junto com a resposta, cada uma em sua linha):
- Na sua primeira resposta do atendimento, e quando o assunto mudar: [MOTIVO:x], com x = ${Object.keys(MOTIVOS).join(', ')}.
- Se o cliente estiver irritado, xingando ou muito insatisfeito: [HUMOR:irritado]. Quando ele se acalmar: [HUMOR:normal].
- Sempre antes de [TRANSFERIR:...]: [RESUMO: o caso em até 3 linhas para o atendente — quem é, o problema, o que já foi feito].
Comprovantes: quando a mensagem ATUAL do cliente tiver a etiqueta "COMPROVANTE DE PAGAMENTO", agradeça, cite o valor lido (ex.: "Recebi seu comprovante de R$ 82,32! 😊") e pergunte se ele deseja que você encaminhe para o Financeiro confirmar a baixa. Se aceitar, transfira para o Financeiro com os dados do comprovante no [RESUMO]. Nunca diga que o pagamento foi confirmado ou baixado. Se for só um agendamento, avise com gentileza que é um agendamento e que o pagamento é confirmado quando for efetivado.`;
  if (!sgp.sgpAtivo()) return base + `
O sistema do provedor (SGP) não está conectado: você não consegue consultar cadastro nem faturas. Para assuntos de fatura, bloqueio ou suporte técnico, peça o CPF do titular e transfira para o setor certo.`;
  return base + `
- [CONSULTAR_CPF:00000000000] — consulta o cadastro no SGP pelo CPF ou CNPJ (só números) que o cliente informou.
- [SELECIONAR_CONTRATO:12345] — quando o CPF tem mais de um contrato, escolha aquele de que o cliente está falando.
- [ENVIAR_FATURA] — o sistema envia ao cliente as faturas em aberto do contrato (valor, vencimento, Pix copia e cola e linha digitável). Não escreva os códigos você mesma.
- [DECLARACAO_QUITACAO] — gera a declaração anual de quitação de débitos do contrato (ano anterior) e envia o link ao cliente.
- [VER_CONEXAO] — consulta de novo no SGP se a conexão do cliente está ONLINE ou OFFLINE (a consulta do CPF já traz isso). Use só para "sem internet", nunca para lentidão.
` + (geral.iaLibera
    ? `- [LIBERAR_CONFIANCA] — faz a liberação em confiança (promessa de pagamento) do contrato suspenso/bloqueado, quando o cliente aceitar. O sistema devolve se liberou, por quantos dias e até quando: informe exatamente isso e depois envie a fatura ([ENVIAR_FATURA]).`
    : `Liberação em confiança: você NÃO faz. Se o contrato estiver bloqueado/suspenso e o cliente pedir para liberar a internet, diga que vai passar para o Financeiro viabilizar a liberação e transfira para o Financeiro ([RESUMO:...] e [TRANSFERIR:financeiro]). Nunca diga que liberou.`) + `
Suporte técnico: faça só o procedimento básico das instruções e depois transfira para o Suporte. Você não abre chamado nem faz testes longos. Coloque no [RESUMO] se a conexão está ONLINE ou OFFLINE.
Regras de privacidade: só confirme o primeiro nome do titular. Nunca mostre CPF, endereço completo ou dados de outros contratos. Faça uma ação por vez.`;
}
const TIPO_PLANO = { fibra: 'Fibra', chip: 'Chip / móvel', combo: 'Fibra + chip', empresa: 'Empresa', outro: 'Outros' };
function regraConhecimento() {
  const k = geral.conhecimento || {};
  let t = '\n\nO QUE VOCÊ SABE (informação oficial da Provedor Exemplo, mantida pela equipe; vale mais que qualquer coisa escrita acima ou dita antes na conversa):';
  if (k.planos?.length) {
    t += '\nPLANOS E PRODUTOS:';
    for (const tipo of Object.keys(TIPO_PLANO)) {
      const l = k.planos.filter(p => p.tipo === tipo); if (!l.length) continue;
      t += `\n[${TIPO_PLANO[tipo]}]` + l.map(p => `\n- ${p.nome}${p.inclui ? ': ' + p.inclui : ''} — ${p.preco || 'preço: o Comercial informa'}${p.obs ? ' (' + p.obs + ')' : ''}`).join('');
    }
    t += '\nSó ofereça produtos desta lista. Se o preço não estiver na lista, diga que o Comercial informa os valores e transfira para o Comercial.';
  }
  if (k.faq?.length) t += '\nPERGUNTAS FREQUENTES (use estas respostas, com suas palavras):' + k.faq.map(f => `\n- Pergunta: ${f.p}\n  Resposta: ${f.r}`).join('');
  if (k.sempre?.length) t += '\nSEMPRE:' + k.sempre.map(x => '\n- ' + x).join('');
  if (k.nunca?.length) t += '\nNUNCA:' + k.nunca.map(x => '\n- ' + x).join('');
  return t;
}
function regraCobertura() {
  const cob = geral.cobertura || {};
  if (!cob.cidades?.length) return '';
  const cidades = cob.cidades.length > 1 ? cob.cidades.slice(0, -1).join(', ') + ' e ' + cob.cidades.at(-1) : cob.cidades[0];
  return `\n\nÁREA DE ATENDIMENTO (esta regra vale mais que qualquer outra informação deste texto ou das mensagens anteriores da conversa):
- A Provedor Exemplo atende SOMENTE em ${cidades}. Não atende em nenhuma outra cidade, distrito ou localidade.
- Quando perguntarem onde atendemos, responda só: "Atendemos em ${cidades}." Não acrescente exceções, bairros ou observações.
` + (cob.semCobertura?.length ? `- Lista interna (NÃO cite ao cliente por conta própria): ainda não há cobertura em ${cob.semCobertura.join(', ')}. Só fale disso se o cliente disser que mora ou quer instalar em um desses lugares; aí diga que ainda não chegamos lá.\n` : '') +
`- Se alguma mensagem anterior sua citou outra cidade, ela estava errada: corrija com naturalidade se o assunto voltar.
- Mesmo dentro dessas cidades, não confirme cobertura de um endereço: o Comercial verifica a viabilidade.`;
}
function sistemaIA(c) {
  const quando = new Date().toLocaleString('pt-BR', { timeZone: TZ });
  const cli = c.sgp?.contrato ? c.sgp.contratos.find(x => x.contrato === c.sgp.contrato) : null;
  const fora = !dentroDoHorario();
  return `${cfg.prompt}\n${regrasAcoes()}\n\nCONTEXTO\nData e hora agora: ${quando}. Nome do contato no WhatsApp: ${c.name || 'não informado'}.` +
    (fora ? `\nAgora estamos FORA do horário de atendimento humano${geral.horario.plantao ? ` (só o setor ${SETORES[geral.horario.plantao]} está de plantão)` : ''}. Resolva o que puder; se precisar transferir, avise que um atendente responde no próximo horário.` : '') +
    regraConhecimento() + regraCobertura() +
    (cli ? `\nCliente já identificado no SGP: contrato ${cli.contrato}, situação ${cli.status}${cli.bloqueado ? ' (bloqueado)' : ''}, plano ${cli.plano || '—'}.` : '');
}

const IMG_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function blocosDe(m, comImagem) {
  if (m.sys) return m.paraIA ? [{ type: 'text', text: m.papel === 'assistant' ? m.text : '[SISTEMA] ' + m.text }] : [];
  if (m.type === 'image' && comImagem && ACEITA_IMAGEM && m.media && IMG_OK.includes(m.mime)) {
    try {
      const buf = fs.readFileSync(path.join(MEDIA_DIR, path.basename(m.media)));
      if (buf.length < 4.5 * 1024 * 1024) return [
        { type: 'image', source: { type: 'base64', media_type: m.mime, data: buf.toString('base64') } },
        { type: 'text', text: (m.text || '[cliente enviou uma foto]') + descreverLeitura(m.leitura, false) }];
    } catch {}
  }
  if (m.type === 'audio' && m.transcricao) return [{ type: 'text', text: '[áudio do cliente, transcrito] ' + m.transcricao }];
  const rotulo = { image: ACEITA_IMAGEM ? '[cliente enviou uma foto]' : '[cliente enviou uma foto, que você não consegue ver; se precisar, peça para descrever]', video: '[cliente enviou um vídeo]', audio: '[cliente enviou um áudio, que você não consegue ouvir; peça para escrever]', document: `[cliente enviou o arquivo ${m.fileName || ''}]` }[m.type];
  const t = [rotulo, m.text].filter(Boolean).join(' ') + (['image', 'document'].includes(m.type) ? descreverLeitura(m.leitura, m.type === 'document') : '');
  return t.trim() ? [{ type: 'text', text: t }] : [];
}
function montarConversa(c) {
  const desde = c.inicio ? c.inicio - 6 * 3600e3 : 0; // atendimento atual + um pouco de contexto
  const recentes = c.msgs.filter(m => m.ts >= desde && !m.auto).slice(-(Number(process.env.IA_HISTORICO) || 16)); // menos histórico = menos tokens por resposta
  const ultimasImgs = new Set(recentes.filter(m => !m.fromMe && !m.sys && m.type === 'image').slice(-2).map(m => m.id));
  const out = [];
  for (const m of recentes) {
    const role = m.sys ? (m.papel === 'assistant' ? 'assistant' : 'user') : m.fromMe ? 'assistant' : 'user';
    let blocos = blocosDe(m, ultimasImgs.has(m.id));
    if (role === 'assistant' && !m.sys) {
      const quem = m.ia ? '' : `[atendente ${m.agent || 'humano'}] `;
      blocos = [{ type: 'text', text: quem + (m.text || `[enviou ${m.type === 'image' ? 'uma foto' : m.type === 'video' ? 'um vídeo' : 'um arquivo'}]`) }];
    }
    if (!blocos.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocos);
    else out.push({ role, content: blocos });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const RE_ACAO = /\[(CONSULTAR_CPF|SELECIONAR_CONTRATO|ENVIAR_FATURA|LIBERAR_CONFIANCA|ABRIR_CHAMADO|DECLARACAO_QUITACAO|VER_CONEXAO|TRANSFERIR|FINALIZAR)(?::\s*([^\]]*))?\]/gi;
const RE_META = /\[(MOTIVO|HUMOR|RESUMO):\s*([^\]]*)\]/gi;
function extrairMeta(texto) {
  const meta = {};
  const limpo = String(texto || '').replace(RE_META, (_, k, v) => { meta[k.toUpperCase()] = v.trim(); return ''; });
  return { texto: limpo, meta };
}
function extrairAcoes(texto) {
  const acoes = [];
  const limpo = String(texto || '').replace(RE_ACAO, (_, nome, arg) => { acoes.push({ nome: nome.toUpperCase(), arg: (arg || '').trim() }); return ''; }).trim();
  return { texto: limpo, acoes };
}

const primeiroNome = n => String(n || '').trim().split(/\s+/)[0] || '';
function descreverContratos(cs) {
  return cs.map(x => `contrato ${x.contrato}: titular ${primeiroNome(x.nome)}, situação ${x.status}${x.bloqueado ? ' (bloqueado)' : ''}, plano ${x.plano || '—'}${x.endereco ? ', ' + x.endereco.split(',').slice(-2).join(',').trim() : ''}${x.valorAberto ? ', em aberto ' + sgp.reais(x.valorAberto) : ''}`).join('\n');
}
const contratoAtual = c => c.sgp?.contrato || (c.sgp?.contratos?.length === 1 ? c.sgp.contratos[0].contrato : null);

// Confere as faturas em aberto logo após identificar o cliente, para a IA já saber se há débito
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const isoDe = d => { const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d || ''); };
async function resumoAcesso(c, cli) {
  const r = await sgp.verificarAcesso(cli.contrato);
  if (!r || r.erro) return '';
  c.sgp.acesso = { contrato: cli.contrato, online: r.online, texto: r.texto, desde: r.desde, ts: agora() };
  if (r.online === null) return r.texto ? `\nConexão no sistema: ${r.texto}.` : '';
  return `\nConexão agora: ${r.online ? 'ONLINE' : 'OFFLINE'}${r.texto ? ` (${r.texto})` : ''}.`;
}
async function resumoDebitos(cli) {
  try {
    const ts = await sgp.titulos(cli.contrato);
    if (!ts.length) return '\nFaturas em aberto: nenhuma. Cliente em dia.';
    const vencidas = ts.filter(t => isoDe(t.vencimento) < hojeISO());
    const total = ts.reduce((a, t) => a + (t.valor || 0), 0);
    return `\nFaturas em aberto: ${ts.length} (total ${sgp.reais(total)})` +
      (vencidas.length ? `, ${vencidas.length} VENCIDA(S): ` + vencidas.map(t => `${t.vencimento} ${sgp.reais(t.valor)}`).join('; ') : ', nenhuma vencida') +
      (ts.some(t => t.pix) ? '. Há Pix disponível.' : '.') +
      (vencidas.length ? ' Avise o cliente com gentileza sobre o débito e ofereça enviar a fatura com Pix ([ENVIAR_FATURA]).' + (cli.bloqueado ? (geral.iaLibera ? ' O contrato está bloqueado: ofereça a liberação em confiança ([LIBERAR_CONFIANCA]) e a fatura.' : ' O contrato está bloqueado: se o cliente pedir para liberar, diga que vai passar para o Financeiro viabilizar a liberação e transfira para o Financeiro.') : '') : '');
  } catch (e) { logger.warn(e, 'falha ao consultar faturas'); return ''; }
}

// Ações também usadas pelos botões do painel. Retornam um texto de resultado.
export const acoesSGP = {
  async buscar(c, doc, por) {
    const r = await sgp.consultarCliente(doc);
    c.sgp = { cpfcnpj: r.cpfcnpj, contratos: r.contratos, contrato: r.contratos.length === 1 ? r.contratos[0].contrato : null };
    if (c.motivo === 'sem_internet') setTimeout(verificarQuedas, 50);
    evento(c, 'sgp_consulta', por); pushChat(c);
    if (!r.contratos.length) return 'Nenhum contrato encontrado para esse CPF/CNPJ. Peça para o cliente conferir o número.';
    let txt = `Encontrado(s) ${r.contratos.length} contrato(s):\n${descreverContratos(r.contratos)}`;
    if (r.contratos.length > 1) return txt + '\nPergunte de qual contrato o cliente está falando.';
    return txt + await resumoDebitos(r.contratos[0]) + await resumoAcesso(c, r.contratos[0]);
  },
  async selecionarComDebitos(c, contrato) {
    const t = this.selecionar(c, contrato);
    const cli = c.sgp?.contratos?.find(x => x.contrato === String(contrato));
    return cli ? t + await resumoDebitos(cli) + await resumoAcesso(c, cli) : t;
  },
  selecionar(c, contrato) {
    if (!c.sgp?.contratos?.some(x => x.contrato === String(contrato))) return 'Esse contrato não está na consulta. Consulte o CPF primeiro.';
    c.sgp.contrato = String(contrato); pushChat(c); if (c.motivo === 'sem_internet') setTimeout(verificarQuedas, 50);
    return `Contrato ${contrato} selecionado.`;
  },
  async enviarFaturas(c, por, idTitulo = null) {
    const ct = contratoAtual(c);
    if (!ct) return 'Nenhum contrato identificado. Consulte o CPF primeiro.';
    let ts = await sgp.titulos(ct);
    if (idTitulo) ts = ts.filter(t => t.id === String(idTitulo));
    if (!ts.length) return `Não há faturas em aberto no contrato ${ct}.`;
    for (const t of ts.slice(0, 3)) {
      const txt = `📄 *Fatura Provedor Exemplo*\nContrato ${ct}\n📅 Vencimento: *${t.vencimento || '—'}*\n💰 Valor: *${sgp.reais(t.valor)}*` + (t.link ? `\n🔗 Boleto: ${t.link}` : '');
      await enviar(c.jid, { text: txt }, { type: 'text', text: txt, ia: por === 'IA', agent: por === 'IA' ? null : por });
      if (t.pix) { await enviar(c.jid, { text: t.pix }, { type: 'text', text: t.pix, ia: por === 'IA', agent: por === 'IA' ? null : por, rotulo: 'Pix copia e cola' }); }
      if (t.linha) { await enviar(c.jid, { text: t.linha }, { type: 'text', text: t.linha, ia: por === 'IA', agent: por === 'IA' ? null : por, rotulo: 'Linha digitável' }); }
    }
    evento(c, 'fatura', por);
    return `Enviada(s) ${Math.min(ts.length, 3)} fatura(s) ao cliente: ` + ts.slice(0, 3).map(t => `${t.vencimento} ${sgp.reais(t.valor)}${t.pix ? ' (com Pix)' : ''}`).join('; ') + '. Confirme rapidamente que enviou, sem repetir os códigos.';
  },
  async liberar(c, por) {
    const ct = contratoAtual(c);
    if (!ct) return 'Nenhum contrato identificado. Consulte o CPF primeiro.';
    const r = await sgp.liberarConfianca(ct);
    evento(c, 'liberacao', por, { ok: r.ok });
    if (r.ok) {
      const cli = c.sgp.contratos.find(x => x.contrato === ct); if (cli) { cli.bloqueado = false; }
      pushChat(c);
      return `Liberação em confiança feita no contrato ${ct}${r.dias ? ` por ${r.dias} dia(s)` : ''}${r.ate ? ` até ${r.ate}` : ''}${r.protocolo ? `, protocolo ${r.protocolo}` : ''}. Peça para o cliente desligar o aparelho da tomada por 30 segundos se a internet não voltar em alguns minutos.`;
    }
    return `O SGP não liberou: ${r.mensagem || 'motivo não informado'}. Explique ao cliente e, se ele precisar, transfira para o Financeiro.`;
  },
  async chamado(c, texto, por) {
    const ct = contratoAtual(c);
    if (!ct) return 'Nenhum contrato identificado. Consulte o CPF primeiro.';
    const r = await sgp.abrirChamado(ct, texto || 'Atendimento via WhatsApp', `Aberto por ${por} · protocolo de atendimento ${c.protocolo || ''}`);
    evento(c, 'chamado', por, { protocolo: r.protocolo });
    return `Chamado aberto no contrato ${ct}${r.protocolo ? `, protocolo ${r.protocolo}` : ' (o SGP não informou o número)'}.`;
  }
};

async function executarAcao(c, a) {
  const precisaSGP = ['CONSULTAR_CPF', 'SELECIONAR_CONTRATO', 'ENVIAR_FATURA', 'LIBERAR_CONFIANCA', 'ABRIR_CHAMADO', 'DECLARACAO_QUITACAO', 'VER_CONEXAO'].includes(a.nome);
  if (precisaSGP && !sgp.sgpAtivo()) return { nota: 'O SGP não está conectado. Transfira para o setor adequado.', continuar: true };
  try {
    switch (a.nome) {
      case 'TRANSFERIR': {
        let s = SETOR_POR_NOME[a.arg.toLowerCase()] || 'sup';
        const fora = !dentroDoHorario();
        if (fora && geral.horario.plantao) s = geral.horario.plantao;
        c.ia = false; c.status = 'espera'; c.sector = s; c.assumed = null; c.assumedId = null;
        evento(c, 'transferiu', 'IA', { setor: s });
        nota(c, `IA transferiu para ${SETORES[s]}${fora ? ' (fora do horário)' : ''}`);
        if (fora && !geral.horario.plantao) await avisarAusencia(c);
        pushChat(c);
        emitirChat(c, 'ia:transferencia', { jid: c.jid, setor: SETORES[s], nome: c.name || c.phone });
        return { parar: true };
      }
      case 'FINALIZAR': await finalizar(c, 'IA'); return { parar: true };
      case 'CONSULTAR_CPF': return { nota: await acoesSGP.buscar(c, a.arg, 'IA'), continuar: true };
      case 'SELECIONAR_CONTRATO': return { nota: await acoesSGP.selecionarComDebitos(c, a.arg), continuar: true };
      case 'ENVIAR_FATURA': return { nota: await acoesSGP.enviarFaturas(c, 'IA'), continuar: true };
      case 'VER_CONEXAO': {
        const ct = contratoAtual(c); const cli = c.sgp?.contratos?.find(x => x.contrato === ct);
        if (!cli) return { nota: 'Nenhum contrato identificado. Consulte o CPF primeiro.', continuar: true };
        return { nota: (await resumoAcesso(c, cli)).trim() || 'O SGP não informou o status da conexão agora.', continuar: true };
      }
      case 'LIBERAR_CONFIANCA': // só se o administrador permitir (Prompts da IA); senão passa para o Financeiro
        if (geral.iaLibera) return { nota: await acoesSGP.liberar(c, 'IA'), continuar: true };
        nota(c, 'IA não faz liberação em confiança: passou para o Financeiro');
        return executarAcao(c, { nome: 'TRANSFERIR', arg: 'financeiro' });
      case 'ABRIR_CHAMADO': // a IA não abre chamado: passa para o Suporte
        nota(c, 'IA não abre chamado: passou para o Suporte' + (a.arg ? ` (${a.arg})` : ''));
        return executarAcao(c, { nome: 'TRANSFERIR', arg: 'suporte' });
      case 'DECLARACAO_QUITACAO': {
        const ct = contratoAtual(c);
        if (!ct) return { nota: 'Nenhum contrato identificado. Consulte o CPF primeiro.', continuar: true };
        const ano = new Date().getFullYear() - 1;
        const r = await sgp.declaracaoQuitacao(ct, ano);
        if (!r) return { nota: 'A declaração automática não está configurada. Avise o cliente que o Financeiro vai enviar e transfira para o Financeiro.', continuar: true };
        if (!r.link) return { nota: `O SGP não gerou a declaração de ${ano}: ${r.mensagem || 'sem motivo informado'}. Explique ao cliente e transfira para o Financeiro.`, continuar: true };
        const t = `📄 *Declaração de quitação ${ano}*\nContrato ${ct}\n${r.link}`;
        await enviar(c.jid, { text: t }, { type: 'text', text: t, ia: true });
        evento(c, 'quitacao', 'IA', { ano });
        return { nota: `Declaração de quitação de ${ano} enviada ao cliente. Confirme rapidamente.`, continuar: true };
      }
    }
  } catch (e) {
    logger.warn(e, 'ação da IA falhou');
    return { nota: `A ação ${a.nome} falhou: ${e.message}. Se não conseguir resolver, transfira para um atendente.`, continuar: true };
  }
  return {};
}

async function responderIA(jid) {
  const c = db.chats[jid];
  if (!c || !c.ia || !iaPronta() || state.status !== 'conectado') return;
  if (iaOcupada.has(jid)) return agendarIA(jid);
  iaOcupada.add(jid);
  try {
    for (let rodada = 0; rodada < 4; rodada++) {
      const messages = montarConversa(c);
      if (!messages.length || messages[messages.length - 1].role !== 'user') return;
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const resposta = await ia.gerar({ system: sistemaIA(c), messages });
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
      if (!c.ia) return; // um atendente assumiu enquanto a IA pensava
      const { texto: semMeta, meta } = extrairMeta(resposta);
      let mudou = false;
      if (meta.MOTIVO) { const m = meta.MOTIVO.toLowerCase().replace(/\s+/g, '_'); if (MOTIVOS[m] && c.motivo !== m) { definirMotivo(c, m); mudou = true; } }
      if (meta.HUMOR) { const h = /irrit|brav|nerv/i.test(meta.HUMOR) ? 'irritado' : null; if (c.humor !== h) { c.humor = h; mudou = true; } }
      if (meta.RESUMO) nota(c, meta.RESUMO, { tipo: 'resumo' });
      if (mudou) pushChat(c);
      const { texto, acoes } = extrairAcoes(semMeta);
      if (texto) await enviar(jid, { text: texto }, { type: 'text', text: texto, ia: true });
      if (!acoes.length) return;
      const NOMES = { CONSULTAR_CPF: 'consultou o CPF', SELECIONAR_CONTRATO: 'selecionou o contrato', ENVIAR_FATURA: 'enviou a fatura', LIBERAR_CONFIANCA: 'pediu liberação em confiança', VER_CONEXAO: 'consultou a conexão', ABRIR_CHAMADO: 'pediu chamado (vai para o Suporte)', DECLARACAO_QUITACAO: 'pediu a declaração de quitação', TRANSFERIR: 'transferiu', FINALIZAR: 'finalizou' };
      const pedidas = acoes.slice(0, 2);
      nota(c, 'IA ' + pedidas.map(a => NOMES[a.nome] + (a.arg && a.nome !== 'CONSULTAR_CPF' ? ` (${a.arg})` : '')).join(' e ') + '\n' + pedidas.map(a => `[${a.nome}${a.arg ? ':' + a.arg : ''}]`).join('\n'), { paraIA: true, papel: 'assistant' });
      let continuar = false;
      for (const a of pedidas) {
        const r = await executarAcao(c, a);
        if (r.nota) nota(c, r.nota, { paraIA: true });
        if (r.parar) return;
        continuar ||= !!r.continuar;
      }
      if (!continuar) return;
    }
  } finally { iaOcupada.delete(jid); }
}

/* ================================================================== */
/* Relatórios                                                         */
/* ================================================================== */
function diaLocal(ts) { return new Date(ts).toLocaleDateString('sv-SE', { timeZone: TZ }); }
const media = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
function relatorio(dias) {
  const desde = agora() - dias * 86400e3;
  const recs = atendimentos.all(desde);
  const chats = Object.values(db.chats);
  const abertos = chats.filter(c => c.status !== 'finalizado');
  const notas = recs.filter(r => r.csat).map(r => r.csat);
  const porDia = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = diaLocal(agora() - i * 86400e3);
    const doDia = recs.filter(r => diaLocal(r.fim) === d);
    porDia.push({ dia: d, total: doDia.length, humano: doDia.filter(r => !r.porIA).length });
  }
  const porSetor = Object.entries(SETORES).map(([k, nome]) => {
    const rs = recs.filter(r => r.setor === k);
    return { setor: k, nome, abertos: abertos.filter(c => c.sector === k).length, finalizados: rs.length, tma: media(rs.map(r => r.tma)) };
  });
  const porAtendente = auth.lista().map(u => {
    const rs = recs.filter(r => r.atendenteId === u.id);
    const ns = rs.filter(r => r.csat).map(r => r.csat);
    return { id: u.id, nome: u.nome, ativo: u.ativo !== false, abertos: abertos.filter(c => c.assumedId === u.id).length, finalizados: rs.length,
      tma: media(rs.map(r => r.tma)), csat: media(ns), avaliacoes: ns.length };
  });
  return {
    dias,
    agora: { automacao: abertos.filter(c => c.status === 'automacao').length, espera: abertos.filter(c => c.status === 'espera').length, andamento: abertos.filter(c => c.status === 'andamento').length },
    finalizados: recs.length, porIA: recs.filter(r => r.porIA).length,
    tma: media(recs.map(r => r.tma)), primeiraResposta: media(recs.filter(r => r.primeiraResposta != null).map(r => r.primeiraResposta)),
    csat: { media: media(notas), total: notas.length, dist: [1, 2, 3, 4, 5].map(n => notas.filter(x => x === n).length) },
    porDia, porSetor, porAtendente,
    motivos: Object.entries(MOTIVOS).map(([k, nome]) => ({ motivo: k, nome, total: recs.filter(r => r.motivo === k).length, abertos: abertos.filter(c => c.motivo === k).length }))
      .filter(m => m.total || m.abertos).sort((a, b) => (b.total + b.abertos) - (a.total + a.abertos)),
    semMotivo: recs.filter(r => !r.motivo).length,
    bairros: (() => {
      const mapa = {};
      const add = (bairro, cidade, chave, aberto) => { if (!bairro) return; const k = `${bairro}|${cidade || ''}`; const o = (mapa[k] ||= { bairro, cidade: cidade || '', sem_internet: 0, lentidao: 0, abertos: 0, total: 0 }); o[chave]++; o.total++; if (aberto) o.abertos++; };
      for (const r of recs) if (['sem_internet', 'lentidao'].includes(r.motivo)) add(r.bairro, r.cidade, r.motivo, false);
      for (const c of abertos) if (['sem_internet', 'lentidao'].includes(c.motivo)) { const cl = clienteAtual(c); add(cl?.bairro, cl?.cidade, c.motivo, true); }
      return Object.values(mapa).sort((a, b) => b.total - a.total).slice(0, 20);
    })()
  };
}

/* ================================================================== */
/* HTTP                                                               */
/* ================================================================== */
const app = express();
app.use(express.json({ limit: '300kb' }));
const api = express.Router();
const ok = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { res.status(e.status || 400).json({ erro: e.message }); } };
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// O painel é o mesmo arquivo publicado como demonstração; aqui ele roda em modo ao vivo.
app.get('/', (_req, res) => {
  const body = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  res.type('html').send('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><script>window.IF_LIVE=true</script><script src="/socket.io/socket.io.js"></script>' +
    '<style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style></head><body>' + body + '</body></html>');
});

const FAVICON = fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'));
app.get(['/favicon.ico', '/favicon.svg'], (_req, res) => res.type('image/svg+xml').set('Cache-Control', 'max-age=86400').send(FAVICON));

// sessão
app.get('/api/sessao', (req, res) => res.json({ usuario: auth.publico(auth.usuarioDe(req)), setup: auth.precisaSetup(), setores: SETORES }));
app.post('/api/setup', ok((req, res) => {
  if (!auth.precisaSetup()) throw erro('O administrador já foi criado.', 409);
  auth.criar({ ...req.body, papel: 'admin', setores: Object.keys(SETORES) });
  const s = auth.entrar(req.body.login, req.body.senha); auth.cookie(res, s.token); registrarAcesso(req, req.body.login, true, 'primeiro acesso'); return s.usuario;
}));
function registrarAcesso(req, login, ok, motivo = '') {
  acessos.data.lista.push({ ts: agora(), login: String(login || '').slice(0, 40), ok, motivo,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(), agente: String(req.headers['user-agent'] || '').slice(0, 160) });
  if (acessos.data.lista.length > 3000) acessos.data.lista.splice(0, acessos.data.lista.length - 3000);
  acessos.save();
}
app.post('/api/login', ok((req, res) => {
  try { const s = auth.entrar(req.body?.login, req.body?.senha); auth.cookie(res, s.token); registrarAcesso(req, req.body?.login, true); return s.usuario; }
  catch (e) { registrarAcesso(req, req.body?.login, false, e.message); throw e; }
}));
app.post('/api/logout', (req, res) => { const u = auth.usuarioDe(req); if (u) registrarAcesso(req, u.login, true, 'saiu'); auth.sair(auth.tokenDe(req)); auth.cookie(res, ''); res.json({ ok: true }); });

app.use('/midia', auth.exigirLogin, express.static(MEDIA_DIR, { maxAge: '7d' }));
app.use('/api', auth.exigirLogin, api);

api.get('/estado', (_req, res) => res.json(state));
api.post('/desconectar', auth.exigirAdmin, ok(async () => { try { await sock?.logout(); } catch {} return { ok: true }; }));

// conversas
api.get('/conversas', (req, res) => res.json(Object.values(db.chats).filter(c => c.msgs.length && podeVer(req.usuario, c)).map(summary).sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0))));
api.get('/conversas/:jid', (req, res) => {
  const c = db.chats[req.params.jid];
  if (!c) return res.json({ jid: req.params.jid, msgs: [], notas: [], tags: [], eventos: [] });
  if (!podeVer(req.usuario, c)) return res.status(403).json({ erro: `Este atendimento está com ${c.assumed || 'outro setor'}.` });
  c.unread = 0; save();
  const atuais = c.inicio ? c.msgs.filter(m => m.ts >= c.inicio - 2000) : c.msgs;
  res.json({ ...summary(c), msgs: atuais.slice(-300), anteriores: historicoDe(c).length, notas: c.notas, eventos: c.eventos, sgp: c.sgp, recorrencia: recorrenciaDe(c.jid) });
});
// Atendimentos anteriores do mesmo cliente (qualquer atendente que está com o cliente agora pode consultar)
function historicoDe(c) {
  return atendimentos.all(0).filter(r => r.jid === c.jid && r.protocolo !== c.protocolo).reverse();
}
api.get('/conversas/:jid/historico', ok(req => {
  const c = conversa(req);
  return historicoDe(c).slice(0, 50).map(r => ({ protocolo: r.protocolo, inicio: r.inicio, fim: r.fim, atendente: r.atendente || (r.porIA ? 'IA' : null), setor: r.setor, porIA: r.porIA,
    motivo: r.motivo, mensagens: c.msgs.filter(m => !m.sys && m.ts >= r.inicio - 2000 && m.ts <= r.fim + 5000).length }));
}));
api.get('/conversas/:jid/historico/:protocolo', ok(req => {
  const c = conversa(req);
  const r = historicoDe(c).find(x => x.protocolo === req.params.protocolo);
  if (!r) throw erro('Atendimento não encontrado.', 404);
  const msgs = c.msgs.filter(m => m.ts >= r.inicio - 2000 && m.ts <= r.fim + 5000 && !m.oculto);
  return { protocolo: r.protocolo, inicio: r.inicio, fim: r.fim, atendente: r.atendente || (r.porIA ? 'IA' : null), setor: r.setor, motivo: r.motivo, msgs };
}));
function conversa(req) {
  const c = db.chats[req.params.jid]; if (!c) throw erro('Conversa não encontrada.', 404);
  if (!podeVer(req.usuario, c)) throw erro(`Este atendimento está com ${c.assumed || 'outro setor'}.`, 403);
  return c;
}
api.post('/conversas/:jid/assumir', ok(req => {
  const c = conversa(req); const u = req.usuario;
  if (c.status === 'finalizado') abrirAtendimento(c);
  c.ia = false; c.status = 'andamento'; c.assumed = u.nome; c.assumedId = u.id; c.teveHumano = true;
  clearTimeout(iaTimers.get(c.jid)); evento(c, 'assumiu', u.nome); nota(c, `${u.nome} assumiu o atendimento`); pushChat(c);
  if (geral.msgAssumir.ativo) auto(c, geral.msgAssumir.texto, u.nome);
  return summary(c);
}));
api.post('/conversas/:jid/transferir', ok(req => {
  const c = conversa(req); const s = SETORES[req.body?.setor] ? req.body.setor : SETOR_POR_NOME[req.body?.setor];
  if (!s) throw erro('Setor inválido.');
  const para = req.body?.atendenteId ? auth.porId(req.body.atendenteId) : null;
  c.ia = false; c.sector = s; clearTimeout(iaTimers.get(c.jid));
  if (para) { c.status = 'andamento'; c.assumed = para.nome; c.assumedId = para.id; c.teveHumano = true; }
  else { c.status = 'espera'; c.assumed = null; c.assumedId = null; }
  evento(c, 'transferiu', req.usuario.nome, { setor: s, para: para?.nome });
  nota(c, `${req.usuario.nome} transferiu para ${SETORES[s]}${para ? ` (${para.nome})` : ''}`); pushChat(c);
  if (geral.avisoTransferencia.ativo) auto(c, geral.avisoTransferencia.texto);
  if (ia.gerar && req.body?.resumo !== false) gerarResumo(c).catch(() => {});
  return summary(c);
}));
api.post('/conversas/:jid/finalizar', ok(async req => { const c = conversa(req); await finalizar(c, req.usuario.nome, req.usuario.id); return summary(c); }));
api.post('/conversas/:jid/devolver-ia', ok(req => {
  if (!ia.gerar) throw erro(`Configure a chave ${VAR_CHAVE} no arquivo .env para usar a IA.`, 409);
  const c = conversa(req);
  if (c.status === 'finalizado') abrirAtendimento(c);
  c.ia = true; c.status = 'automacao'; c.assumed = null; c.assumedId = null;
  evento(c, 'devolveu_ia', req.usuario.nome); nota(c, `${req.usuario.nome} devolveu o atendimento para a IA`); pushChat(c);
  return summary(c);
}));
api.post('/conversas/:jid/notas', ok(req => {
  const c = conversa(req); const texto = String(req.body?.texto || '').trim(); if (!texto) throw erro('Escreva a anotação.');
  const n = { id: crypto.randomUUID(), ts: agora(), autor: req.usuario.nome, texto: texto.slice(0, 2000) };
  c.notas.push(n); save(); emitirChat(c, 'conversa:notas', { jid: c.jid, notas: c.notas }); return c.notas;
}));
api.delete('/conversas/:jid/notas/:id', ok(req => {
  const c = conversa(req); c.notas = c.notas.filter(n => n.id !== req.params.id); save(); emitirChat(c, 'conversa:notas', { jid: c.jid, notas: c.notas }); return c.notas;
}));
api.put('/conversas/:jid/tags', ok(req => {
  const c = conversa(req); const validas = new Set(tags.data.lista.map(t => t.id));
  c.tags = (req.body?.tags || []).filter(t => validas.has(t)); pushChat(c); return c.tags;
}));

// SGP pelo painel
api.get('/sgp/status', (_req, res) => res.json({ ativo: sgp.sgpAtivo() }));
api.post('/sgp/teste', auth.exigirAdmin, ok(async req => {
  const r = await sgp.consultarCliente(req.body?.cpfcnpj);
  const out = { '1_consultacliente_bruto': r.raw, '2_como_o_nexochat_entendeu': r.contratos };
  if (r.contratos[0]) {
    try { out['3_titulos_bruto'] = await sgp.titulos(r.contratos[0].contrato, true); out['4_titulos_entendidos'] = await sgp.titulos(r.contratos[0].contrato); }
      catch (e) { out['3_titulos_erro'] = e.message; }
      try { out['5_conexao_bruto'] = await sgp.verificarAcesso(r.contratos[0].contrato, true); const a = await sgp.verificarAcesso(r.contratos[0].contrato); out['6_conexao_entendida'] = { online: a.online, texto: a.texto, desde: a.desde, ip: a.ip }; }
    catch (e) { out['5_conexao_erro'] = e.message; }
  }
  return out;
}));
api.post('/conversas/:jid/sgp/buscar', ok(async req => { const c = conversa(req); const r = await acoesSGP.buscar(c, req.body?.cpfcnpj, req.usuario.nome); nota(c, `${req.usuario.nome} consultou o SGP`); return { resultado: r, sgp: c.sgp }; }));
api.post('/conversas/:jid/sgp/contrato', ok(req => { const c = conversa(req); acoesSGP.selecionar(c, req.body?.contrato); return c.sgp; }));
api.get('/conversas/:jid/sgp/titulos', ok(async req => { const c = conversa(req); const ct = contratoAtual(c); if (!ct) throw erro('Selecione um contrato.'); return sgp.titulos(ct); }));
api.post('/conversas/:jid/sgp/enviar-fatura', ok(async req => { const c = conversa(req); return { resultado: await acoesSGP.enviarFaturas(c, req.usuario.nome, req.body?.id) }; }));
api.get('/conversas/:jid/sgp/acesso', ok(async req => {
  const c = conversa(req); const ct = contratoAtual(c); if (!ct) throw erro('Selecione um contrato.');
  const r = await sgp.verificarAcesso(ct);
  if (r.erro) throw erro('O SGP não respondeu o status da conexão: ' + r.texto, 502);
  c.sgp.acesso = { contrato: ct, online: r.online, texto: r.texto, desde: r.desde, ts: agora() }; save();
  return { ...c.sgp.acesso, ip: r.ip };
}));
api.post('/conversas/:jid/sgp/liberar', ok(async req => { const c = conversa(req); const r = await acoesSGP.liberar(c, req.usuario.nome); nota(c, r); return { resultado: r }; }));
api.post('/conversas/:jid/sgp/chamado', ok(async req => { const c = conversa(req); const r = await acoesSGP.chamado(c, req.body?.texto, req.usuario.nome); nota(c, r); return { resultado: r }; }));

// envio
function toJid(to) {
  if (to.includes('@')) return to;
  let n = to.replace(/\D/g, '');
  if (n.length <= 11) n = '55' + n;
  return `${n}@s.whatsapp.net`;
}
async function resolveJid(to) {
  const jid = toJid(to);
  if (jid.endsWith('@s.whatsapp.net')) {
    const [r] = (await sock.onWhatsApp(phoneFromJid(jid)).catch(() => [])) || [];
    if (r && !r.exists) throw erro('Esse número não tem WhatsApp.');
    if (r?.jid) return r.jid;
  }
  return jid;
}
function marcarHumano(jid, u) {
  const c = chatOf(jid);
  if (c.status === 'andamento' && c.assumedId && c.assumedId !== u.id && u.papel !== 'admin') throw erro(`Este atendimento está com ${c.assumed}.`, 403);
  if (c.status === 'finalizado') abrirAtendimento(c);
  if (c.ia || c.status !== 'andamento' || c.assumedId !== u.id) {
    c.ia = false; c.status = 'andamento'; c.assumed = u.nome; c.assumedId = u.id; c.teveHumano = true; clearTimeout(iaTimers.get(jid));
    evento(c, 'assumiu', u.nome); pushChat(c);
  }
}
api.post('/enviar', ok(async req => {
  if (state.status !== 'conectado') throw erro('WhatsApp não está conectado. Leia o QR Code em Canais.', 409);
  const { para, texto } = req.body || {};
  if (!para || !texto?.trim()) throw erro('Informe o destinatário e a mensagem.');
  const jid = await resolveJid(para);
  marcarHumano(jid, req.usuario);
  const saida = geral.identificarAtendente ? `*${req.usuario.nome}:*\n${texto}` : texto;
  return enviar(jid, { text: saida }, { type: 'text', text: texto, agent: req.usuario.nome });
}));
const upload = multer({
  storage: multer.diskStorage({ destination: MEDIA_DIR, filename: (_r, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname || '').toLowerCase()) }),
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});
api.post('/enviar-midia', upload.single('arquivo'), ok(async req => {
  if (state.status !== 'conectado') throw erro('WhatsApp não está conectado. Leia o QR Code em Canais.', 409);
  const f = req.file; const { para, legenda = '' } = req.body || {};
  const ptt = req.body?.ptt === '1'; // áudio gravado no painel: vai como mensagem de voz
  if (!f || !para) throw erro('Envie o arquivo e o destinatário.');
  const jid = await resolveJid(para);
  const buf = fs.readFileSync(f.path);
  const mime = f.mimetype || 'application/octet-stream';
  let content, type;
  const cap = legenda && geral.identificarAtendente ? `*${req.usuario.nome}:*\n${legenda}` : legenda;
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') { content = { image: buf, caption: cap, mimetype: mime }; type = 'image'; }
  else if (mime.startsWith('video/')) { content = { video: buf, caption: cap, mimetype: mime }; type = 'video'; }
  else if (mime.startsWith('audio/')) { content = ptt ? { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: Math.round(Number(req.body?.segundos) || 0) || undefined } : { audio: buf, mimetype: mime }; type = 'audio'; }
  else { content = { document: buf, mimetype: mime, fileName: f.originalname, caption: cap }; type = 'document'; }
  marcarHumano(jid, req.usuario);
  return enviar(jid, content, { type, text: type === 'audio' ? '' : legenda, mime: ptt ? 'audio/ogg' : mime, fileName: f.originalname, media: `/midia/${f.filename}`, agent: req.usuario.nome, ...(ptt ? { ptt: true } : {}) });
}));

// ---------- Ensinar a IA com um texto ou arquivo: ela organiza em planos, perguntas frequentes e regras ----------
const nomeKey = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function diferencasConhecimento(antes, depois, cobAntes, cobDepois) {
  const out = [];
  const mapa = l => new Map((l || []).map(x => [nomeKey(x.nome || x.p), x]));
  const pa = mapa(antes.planos), pd = mapa(depois.planos);
  for (const [k, x] of pd) {
    const v = pa.get(k);
    if (!v) out.push({ tipo: 'novo', area: 'Plano', texto: `${x.nome}${x.inclui ? ' · ' + x.inclui : ''}${x.preco ? ' · ' + x.preco : ''}` });
    else { const muda = ['tipo', 'inclui', 'preco', 'obs'].filter(c => String(v[c] || '') !== String(x[c] || ''));
      if (muda.length) out.push({ tipo: 'alterado', area: 'Plano', texto: `${x.nome}: ` + muda.map(c => `${{ tipo: 'tipo', inclui: 'inclui', preco: 'preço', obs: 'observação' }[c]} "${v[c] || '—'}" → "${x[c] || '—'}"`).join('; ') }); }
  }
  for (const [k, v] of pa) if (!pd.has(k)) out.push({ tipo: 'removido', area: 'Plano', texto: v.nome });
  const fa = mapa(antes.faq), fd = mapa(depois.faq);
  for (const [k, x] of fd) { const v = fa.get(k);
    if (!v) out.push({ tipo: 'novo', area: 'Pergunta', texto: `${x.p} → ${x.r}` });
    else if (v.r !== x.r) out.push({ tipo: 'alterado', area: 'Pergunta', texto: `${x.p} → ${x.r}` }); }
  for (const [k, v] of fa) if (!fd.has(k)) out.push({ tipo: 'removido', area: 'Pergunta', texto: v.p });
  for (const campo of ['sempre', 'nunca']) {
    const a = new Set((antes[campo] || []).map(nomeKey)), d = new Set((depois[campo] || []).map(nomeKey));
    for (const x of depois[campo] || []) if (!a.has(nomeKey(x))) out.push({ tipo: 'novo', area: campo === 'sempre' ? 'Sempre' : 'Nunca', texto: x });
    for (const x of antes[campo] || []) if (!d.has(nomeKey(x))) out.push({ tipo: 'removido', area: campo === 'sempre' ? 'Sempre' : 'Nunca', texto: x });
  }
  if (cobDepois && JSON.stringify(cobAntes) !== JSON.stringify(cobDepois)) out.push({ tipo: 'alterado', area: 'Cidades', texto: `${cobDepois.cidades.join(', ')}${cobDepois.semCobertura.length ? ' · sem cobertura: ' + cobDepois.semCobertura.join(', ') : ''}` });
  return out;
}
api.post('/ia/aprender', auth.exigirAdmin, upload.single('arquivo'), ok(async req => {
  const texto = String(req.body?.texto || '').slice(0, 40000);
  const f = req.file;
  if (!texto.trim() && !f) throw erro('Cole um texto ou escolha um arquivo.');
  if (!ia.gerar) throw erro(`Configure a chave ${VAR_CHAVE} no arquivo .env para usar a IA.`, 409);
  const atual = geral.conhecimento, cob = geral.cobertura;
  const instr = `Você organiza a base de conhecimento da atendente virtual da Provedor Exemplo (provedor de internet).
Abaixo está a base ATUAL. O usuário vai mandar um texto ou arquivo novo da empresa sobre os serviços.
Devolva SOMENTE a base ATUALIZADA, em JSON, neste formato:
{"planos":[{"tipo":"fibra|chip|combo|empresa|outro","nome":"","inclui":"","preco":"","obs":""}],"faq":[{"p":"pergunta do cliente","r":"resposta"}],"sempre":["regra"],"nunca":["regra"],"cidades":["cidade"] ou null,"semCobertura":["bairro (cidade)"] ou null}
Regras:
- Mantenha tudo o que já existe e que o texto novo não contradiz.
- Plano com o mesmo nome (ou claramente o mesmo produto): atualize os dados. Se o texto disser que um plano/produto não existe mais, remova.
- Acrescente planos e produtos novos. "tipo": fibra (só internet fibra), chip (linha móvel), combo (fibra + chip), empresa (planos empresariais), outro.
- Preço no formato "R$ 109,90/mês". Sem preço no texto: "".
- Informações úteis para o cliente (instalação, fidelidade, formas de pagamento, prazos, horários, condições, documentos) viram perguntas frequentes com respostas curtas e simpáticas no estilo WhatsApp.
- Orientações de comportamento para a atendente vão para "sempre" ou "nunca".
- "cidades"/"semCobertura": só preencha se o texto falar de onde a empresa atende; senão use null.
- Não invente nada que não esteja no texto ou na base atual. Não repita a mesma informação em dois lugares.
BASE ATUAL:
${JSON.stringify({ ...atual, cidades: cob.cidades, semCobertura: cob.semCobertura })}`;
  let bruto;
  try {
    if (f) {
      const buf = fs.readFileSync(f.path); fs.rmSync(f.path, { force: true });
      const mime = /pdf/i.test(f.mimetype + f.originalname) ? 'application/pdf' : f.mimetype;
      if (!/^image\/(jpeg|png|webp)$|pdf/.test(mime)) throw erro('Envie PDF, JPG, PNG ou WEBP.');
      bruto = await ia.analisarArquivo(buf, mime, instr + (texto.trim() ? `\n\nTEXTO ADICIONAL DO USUÁRIO:\n${texto}` : '\n\nO conteúdo novo está no arquivo anexado.'));
    } else {
      bruto = await ia.gerar({ system: instr, maxTokens: 6000, messages: [{ role: 'user', content: [{ type: 'text', text: 'TEXTO NOVO DA EMPRESA:\n' + texto }] }] });
    }
  } catch (e) { if (f) fs.rmSync(f.path, { force: true }); throw e.status ? e : erro(explicarErro(e), 502); }
  const j = lerJson(bruto);
  if (!j || !Array.isArray(j.planos)) throw erro('A IA não conseguiu organizar esse texto. Tente de novo ou divida em partes menores.', 502);
  // normaliza do mesmo jeito que o salvamento
  const TIPOS = ['fibra', 'chip', 'combo', 'empresa', 'outro'], t = (v, n) => String(v ?? '').trim().slice(0, n);
  const proposta = {
    planos: j.planos.map(x => ({ tipo: TIPOS.includes(x?.tipo) ? x.tipo : 'outro', nome: t(x?.nome, 80), inclui: t(x?.inclui, 300), preco: t(x?.preco, 60), obs: t(x?.obs, 300) })).filter(x => x.nome).slice(0, 60),
    faq: (j.faq || []).map(x => ({ p: t(x?.p, 300), r: t(x?.r, 1500) })).filter(x => x.p && x.r).slice(0, 80),
    sempre: (j.sempre || []).map(x => t(x, 400)).filter(Boolean).slice(0, 60),
    nunca: (j.nunca || []).map(x => t(x, 400)).filter(Boolean).slice(0, 60)
  };
  const cobertura = Array.isArray(j.cidades) && j.cidades.length ? { cidades: j.cidades.map(x => t(x, 80)).filter(Boolean), semCobertura: (j.semCobertura || []).map(x => t(x, 120)).filter(Boolean) } : null;
  return { proposta, cobertura, mudancas: diferencasConhecimento(atual, proposta, cob, cobertura) };
}));

// ---------- Telefone VoIP (SIP no navegador) ----------
app.use('/vendor', express.static(path.join(ROOT, 'public', 'vendor'), { maxAge: '30d' }));
api.get('/quedas', (req, res) => res.json(quedasAgora()));
api.get('/voip/conta', (req, res) => {
  const v = geral.voip, sip = req.usuario.sip;
  res.json({ ativo: !!(v.ativo && v.wss && v.dominio), wss: v.wss, dominio: v.dominio, stun: v.stun, prefixo: v.prefixo, ddd: v.ddd, formato: v.formato,
    ramal: sip?.ramal || '', senha: sip?.senha || '', nome: req.usuario.nome });
});
const soNum = s => String(s || '').replace(/\D/g, '');
function conversaPorNumero(numero) {
  const n = soNum(numero).slice(-8);
  if (n.length < 8) return null;
  return Object.values(db.chats).filter(c => soNum(c.phone).slice(-8) === n).sort((a, b) => (b.msgs.at(-1)?.ts || 0) - (a.msgs.at(-1)?.ts || 0))[0] || null;
}
api.get('/voip/quem', (req, res) => { const c = conversaPorNumero(req.query.numero); res.json(c ? { jid: c.jid, nome: c.name, cliente: clienteAtual(c)?.nome || null } : {}); });
api.post('/voip/registro', ok(req => {
  const { numero, direcao, duracao = 0, status, jid } = req.body || {};
  const c = (jid && db.chats[jid]) || conversaPorNumero(numero);
  const reg = { ts: agora(), canal: 'voip', direcao: direcao === 'entrada' ? 'entrada' : 'saida', numero: soNum(numero), jid: c?.jid || null,
    status: ['atendida', 'perdida', 'recusada', 'falhou', 'cancelada'].includes(status) ? status : 'atendida', duracao: Math.max(0, Math.round(Number(duracao) || 0)),
    atendente: req.usuario.nome, atendenteId: req.usuario.id };
  ligacoes.data.lista.push(reg);
  if (ligacoes.data.lista.length > 3000) ligacoes.data.lista.splice(0, ligacoes.data.lista.length - 3000);
  ligacoes.save();
  if (c) {
    const d = reg.duracao, tempo = d ? ` · ${Math.floor(d / 60)}min${String(d % 60).padStart(2, '0')}s` : '';
    const txt = { atendida: reg.direcao === 'saida' ? `📞 ${req.usuario.nome} ligou para o cliente${tempo}` : `📞 ${req.usuario.nome} atendeu ligação do cliente${tempo}`,
      perdida: '📞 Ligação perdida do cliente', recusada: `📞 ${req.usuario.nome} recusou a ligação`, falhou: `📞 Ligação para o cliente não completou`, cancelada: `📞 ${req.usuario.nome} cancelou a ligação` }[reg.status];
    nota(c, txt); evento(c, 'ligacao', req.usuario.nome, { direcao: reg.direcao, status: reg.status, duracao: reg.duracao }); c.ligou = null; pushChat(c);
  }
  return reg;
}));
api.get('/voip/historico', (req, res) => res.json(ligacoes.data.lista.slice(-60).reverse().map(l => ({ ...l, nome: l.jid ? db.chats[l.jid]?.name || '' : '' }))));

// ---------- Chat interno da equipe, resumo e sugestão de resposta ----------
api.post('/conversas/:jid/interno', ok(req => {
  const c = conversa(req); const texto = String(req.body?.texto || '').trim().slice(0, 2000);
  if (!texto) throw erro('Escreva a mensagem.');
  const citados = auth.lista().filter(u => u.ativo !== false && u.id !== req.usuario.id &&
    new RegExp('@' + u.nome.split(/\s+/)[0].normalize('NFD').replace(/[̀-ͯ]/g, '') + '\\b', 'i').test(texto.normalize('NFD').replace(/[̀-ͯ]/g, '')));
  const m = { id: 'i' + crypto.randomBytes(6).toString('hex'), sys: true, interno: true, papel: 'interno', ts: agora(), type: 'text', text: texto,
    autor: req.usuario.nome, autorId: req.usuario.id, mencoes: citados.map(u => u.id) };
  c.msgs.push(m); save();
  emitirChat(c, 'wa:message', { chat: summary(c), msg: m });
  for (const u of citados) io.to('u:' + u.id).emit('interno:mencao', { jid: c.jid, cliente: c.name, autor: req.usuario.nome, texto: texto.slice(0, 140) });
  return m;
}));
api.post('/conversas/:jid/resumo', ok(async req => {
  const c = conversa(req);
  try { return { resumo: await gerarResumo(c) }; } catch (e) { throw erro(explicarErro(e), e.status || 502); }
}));
api.post('/conversas/:jid/sugestao', ok(async req => {
  const c = conversa(req);
  const cli = clienteAtual(c);
  const instr = `${cfg.prompt}${regraConhecimento()}${regraCobertura()}\n\nVocê agora está ajudando o atendente humano ${req.usuario.nome} da Provedor Exemplo. Escreva a PRÓXIMA mensagem que ele deve mandar ao cliente, em português, curta, no estilo WhatsApp, como se fosse ele falando (primeira pessoa). Não use códigos entre colchetes, não invente dados, valores ou protocolos que não estejam na conversa. Responda só com o texto da mensagem.` +
    (cli ? `\nCliente no SGP: contrato ${cli.contrato}, ${cli.status}${cli.bloqueado ? ' (bloqueado)' : ''}, plano ${cli.plano || '—'}.` : '');
  try { return { texto: await perguntarIA(instr, transcricao(c, 30), 400) }; } catch (e) { throw erro(explicarErro(e), e.status || 502); }
}));

// IA
const iaInfo = () => ({ ...cfg, rodizio: estadoRodizio(), envArquivo: ENV_ARQUIVO, pasta: ROOT, temChave: !!ia.gerar, provedor: NOME_PROVEDOR, varChave: VAR_CHAVE, padrao: PROMPT_PADRAO, sgp: sgp.sgpAtivo(), transcreve: !!ia.transcrever, chavesArquivo: CHAVES_ARQUIVO, testeChaves: ultimoTesteChaves });
api.get('/ia', (_req, res) => res.json(iaInfo()));
api.post('/ia/testar-chaves', auth.exigirAdmin, ok(async () => { ultimoTesteChaves = await verificarChaves(); return ultimoTesteChaves; }));
api.put('/ia', auth.exigirAdmin, ok(req => {
  const { iaAtiva, prompt, modelo, csat, modeloReserva, temperatura } = req.body || {};
  if (typeof modeloReserva === 'string') cfg.modeloReserva = modeloReserva.trim();
  if (temperatura !== undefined && Number.isFinite(Number(temperatura))) cfg.temperatura = Math.min(Math.max(Number(temperatura), 0), 1.5);
  if (typeof iaAtiva === 'boolean') cfg.iaAtiva = iaAtiva;
  if (typeof csat === 'boolean') cfg.csat = csat;
  if (typeof prompt === 'string' && prompt.trim()) cfg.prompt = prompt;
  if (typeof modelo === 'string' && modelo.trim()) cfg.modelo = modelo.trim();
  salvarCfg(); return iaInfo();
}));
api.post('/ia/testar', ok(async req => {
  if (!ia.gerar) throw erro(`Configure a chave ${VAR_CHAVE} no arquivo .env e reinicie.`, 409);
  const t0 = agora();
  const hist = Array.isArray(req.body?.historico) && req.body.historico.length ? req.body.historico.slice(-16)
    : [{ de: 'cliente', texto: String(req.body?.texto || 'Oi, quais são os planos?') }];
  const messages = [];
  for (const h of hist) {
    const role = h.de === 'ia' ? 'assistant' : 'user', text = String(h.texto || '').slice(0, 2000) || ' ';
    const prev = messages.at(-1);
    if (prev && prev.role === role) prev.content.push({ type: 'text', text }); else messages.push({ role, content: [{ type: 'text', text }] });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const bruto = await ia.gerar({ system: sistemaIA({ name: 'Teste', msgs: [] }) + '\n\n(MODO TESTE: esta conversa é um teste da equipe no painel. Ações do sistema não são executadas.)', maxTokens: 600, messages })
    .catch(e => { throw erro(explicarErro(e), 502); });
  const { texto: semMeta, meta } = extrairMeta(bruto);
  const { texto, acoes } = extrairAcoes(semMeta);
  return { resposta: texto, acoes: acoes.map(a => a.nome + (a.arg ? ': ' + a.arg : '')), meta, ms: agora() - t0, modelo: cfg.modelo };
}));

// respostas rápidas
const RESPOSTAS_PADRAO = [
  ['oi', 'Saudação', 'Olá! Aqui é {atendente}, da Provedor Exemplo 😊 Como posso ajudar?'],
  ['cpf', 'Pedir CPF', 'Para localizar seu cadastro, me informe por favor o CPF do titular do contrato.'],
  ['foto', 'Foto do aparelho', 'Pode me enviar uma foto do aparelho da internet (ONU) mostrando as luzes acesas?'],
  ['reiniciar', 'Reiniciar aparelho', 'Desligue o aparelho da internet da tomada, espere 30 segundos e ligue de novo. Me avise quando as luzes estabilizarem.'],
  ['visita', 'Visita técnica', 'Abri um chamado técnico. Nossa equipe entra em contato para agendar a visita.'],
  ['fim', 'Encerrar', 'Posso ajudar em mais alguma coisa? Obrigado por falar com a Provedor Exemplo! 💙']
].map(([atalho, titulo, texto]) => ({ id: crypto.randomUUID(), atalho, titulo, texto }));
if (!respostas.data.lista) { respostas.data.lista = RESPOSTAS_PADRAO; respostas.saveNow(); }
const limparAtalho = s => String(s || '').trim().toLowerCase().replace(/^\//, '').replace(/[^a-z0-9_-]/g, '').slice(0, 20);
api.get('/respostas', (_req, res) => res.json(respostas.data.lista));
api.post('/respostas', ok(req => {
  const { atalho, titulo, texto } = req.body || {};
  if (!String(texto || '').trim() || !String(titulo || '').trim()) throw erro('Preencha título e texto.');
  const r = { id: crypto.randomUUID(), atalho: limparAtalho(atalho || titulo), titulo: String(titulo).trim(), texto: String(texto).trim() };
  respostas.data.lista.push(r); respostas.save(); io.emit('respostas', respostas.data.lista); return r;
}));
api.put('/respostas/:id', ok(req => {
  const r = respostas.data.lista.find(x => x.id === req.params.id); if (!r) throw erro('Resposta não encontrada.', 404);
  const { atalho, titulo, texto } = req.body || {};
  if (titulo !== undefined) r.titulo = String(titulo).trim(); if (texto !== undefined) r.texto = String(texto).trim(); if (atalho !== undefined) r.atalho = limparAtalho(atalho);
  respostas.save(); io.emit('respostas', respostas.data.lista); return r;
}));
api.delete('/respostas/:id', ok(req => {
  respostas.data.lista = respostas.data.lista.filter(x => x.id !== req.params.id); respostas.save(); io.emit('respostas', respostas.data.lista); return { ok: true };
}));

// tags
api.get('/tags', (_req, res) => res.json(tags.data.lista));
api.post('/tags', ok(req => {
  const nome = String(req.body?.nome || '').trim().slice(0, 24); if (!nome) throw erro('Dê um nome para a tag.');
  const cor = /^#[0-9a-f]{6}$/i.test(req.body?.cor || '') ? req.body.cor : '#2547d0';
  const t = { id: crypto.randomUUID(), nome, cor }; tags.data.lista.push(t); tags.save(); io.emit('tags', tags.data.lista); return t;
}));
api.delete('/tags/:id', auth.exigirAdmin, ok(req => {
  tags.data.lista = tags.data.lista.filter(t => t.id !== req.params.id); tags.save();
  for (const c of Object.values(db.chats)) if (c.tags?.includes(req.params.id)) c.tags = c.tags.filter(x => x !== req.params.id);
  save(); io.emit('tags', tags.data.lista); return { ok: true };
}));

// atendentes
api.get('/usuarios', (_req, res) => res.json(auth.lista().map(auth.publico)));
api.post('/usuarios', auth.exigirAdmin, ok(req => auth.criar(req.body || {})));
api.put('/usuarios/:id', ok(req => {
  const proprio = req.params.id === req.usuario.id;
  if (req.usuario.papel !== 'admin' && !proprio) throw erro('Somente administradores podem fazer isso.', 403);
  const dados = req.usuario.papel === 'admin' ? req.body : { senha: req.body?.senha, nome: req.body?.nome };
  return auth.editar(req.params.id, dados || {});
}));

// relatórios e CSAT
const ehAdmin = req => req.usuario?.papel === 'admin';
api.get('/relatorios', (req, res) => {
  const r = relatorio(Math.min(Math.max(Number(req.query.dias) || 7, 1), 90));
  if (!ehAdmin(req)) { r.csat = null; r.porAtendente = r.porAtendente.map(({ csat, avaliacoes, ...x }) => x); }
  res.json(r);
});
api.get('/csat', auth.exigirAdmin, (req, res) => {
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  res.json(atendimentos.all(agora() - dias * 86400e3).filter(r => r.csat).sort((a, b) => b.fim - a.fim).slice(0, 200));
});

// ---------- Fase 1: configurações gerais, contatos, logs, consumo, recorrência, finalizados ----------
function recorrenciaDe(jid) {
  const recs = atendimentos.all(agora() - 30 * 86400e3).filter(r => r.jid === jid);
  return { d7: recs.filter(r => r.fim >= agora() - 7 * 86400e3).length, d30: recs.length };
}
api.get('/geral', (_req, res) => res.json({ ...geral, padrao: geralPadrao, dentroDoHorario: dentroDoHorario() }));
api.put('/geral', auth.exigirAdmin, ok(req => { const { padrao, dentroDoHorario: _x, ...patch } = req.body || {}; return { ...salvarGeral(patch), padrao: geralPadrao, dentroDoHorario: dentroDoHorario() }; }));
api.put('/conversas/:jid/nome', ok(req => {
  const c = conversa(req); const nome = String(req.body?.nome || '').trim().slice(0, 60);
  if (!nome) throw erro('Digite o nome do contato.');
  c.name = nome; pushChat(c); return summary(c);
}));
api.get('/contatos/bloqueados', (_req, res) => res.json(geral.bloqueados.map(n => ({ numero: n, nome: Object.values(db.chats).find(c => c.phone === n)?.name || '' }))));
api.post('/contatos/bloquear', ok(req => {
  const c = req.body?.jid ? db.chats[req.body.jid] : null;
  const n = String(req.body?.numero || c?.phone || '').replace(/\D/g, '');
  if (n.length < 10) throw erro('Número inválido.');
  salvarGeral({ bloqueados: [...geral.bloqueados, n] });
  if (c && c.status !== 'finalizado') { nota(c, `${req.usuario.nome} bloqueou este contato`); finalizar(c, req.usuario.nome, req.usuario.id, { semCsat: true }); }
  return geral.bloqueados;
}));
api.post('/contatos/desbloquear', ok(req => {
  const n = String(req.body?.numero || '').replace(/\D/g, '');
  salvarGeral({ bloqueados: geral.bloqueados.filter(x => x !== n) }); return geral.bloqueados;
}));
api.get('/acessos', auth.exigirAdmin, (_req, res) => res.json(acessos.data.lista.slice(-500).reverse()));
api.get('/consumo', (req, res) => {
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  const lista = [];
  for (let i = dias - 1; i >= 0; i--) { const d = diaLocal(agora() - i * 86400e3); lista.push({ dia: d, ...(consumo.data.dias[d] || { chamadas: 0, entrada: 0, saida: 0, custo: 0, transcricoes: 0, modelos: {} }) }); }
  const soma = k => lista.reduce((a, d) => a + (d[k] || 0), 0);
  res.json({ provedor: NOME_PROVEDOR, modelo: cfg.modelo, dias: lista, total: { chamadas: soma('chamadas'), entrada: soma('entrada'), saida: soma('saida'), custo: soma('custo'), transcricoes: soma('transcricoes') } });
});
api.get('/recorrencia', (req, res) => {
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  const recs = atendimentos.all(agora() - dias * 86400e3).sort((a, b) => a.fim - b.fim);
  const porJid = {};
  for (const r of recs) (porJid[r.jid] ||= []).push(r);
  const voltou = (r, horas) => { const l = porJid[r.jid]; const i = l.indexOf(r); const prox = l[i + 1]; return prox && prox.inicio - r.fim <= horas * 3600e3; };
  const mesmoDia = r => { const l = porJid[r.jid]; const prox = l[l.indexOf(r) + 1]; return prox && diaLocal(prox.inicio) === diaLocal(r.fim); };
  const ia_ = recs.filter(r => r.porIA), hum = recs.filter(r => !r.porIA);
  res.json({
    dias, total: recs.length, resolvidosIA: ia_.length, resolvidosAtendente: hum.length,
    voltaramMesmoDia: recs.filter(mesmoDia).length,
    voltaram24h: recs.filter(r => voltou(r, 24)).length,
    voltaramAposIA: ia_.filter(r => voltou(r, 48)).length,
    voltaramAposAtendente: hum.filter(r => voltou(r, 48)).length,
    clientes3mais: Object.values(porJid).filter(l => l.length >= 3).length,
    ranking: Object.values(porJid).filter(l => l.length >= 2).sort((a, b) => b.length - a.length).slice(0, 15)
      .map(l => ({ jid: l[0].jid, nome: l.at(-1).nome, telefone: l.at(-1).telefone, total: l.length, ultimo: l.at(-1).fim, porIA: l.filter(r => r.porIA).length }))
  });
});
api.get('/finalizados', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase(), qd = q.replace(/\D/g, '');
  const recs = atendimentos.all(0).reverse().filter(r => !q || [r.nome, r.protocolo, r.contrato, r.atendente].join(' ').toLowerCase().includes(q) || (qd.length >= 4 && String(r.telefone || '').includes(qd)));
  res.json(recs.filter(r => ehAdmin(req) || r.atendenteId === req.usuario.id).slice(0, 100).map(r => ehAdmin(req) ? r : { ...r, csat: null }));
});

// ---------- Possíveis quedas: vários clientes do mesmo bairro sem internet em pouco tempo ----------
const PALAVRAS_SEM_INTERNET = /(sem|caiu|cair|parou|n[aã]o (t[aá]|est[aá]) (pegando|funcionando)).{0,18}(internet|net\b|sinal|conex|wi-?fi)|(internet|net\b|sinal|conex[aã]o).{0,14}(caiu|parou|n[aã]o (t[aá]|est[aá]|funciona)|sumiu|fora)|luz vermelha|\blos\b.{0,10}(vermelh|piscando|aceso)/i;
const semInternetRecentes = []; // atendimentos finalizados recentes com motivo "sem internet"
function definirMotivo(c, m) {
  c.motivo = m; c.motivoTs = agora();
  if (m === 'sem_internet') setTimeout(verificarQuedas, 50);
}
const normTxt = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const capTxt = s => String(s || '').toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).replace(/\b(De|Do|Da|Dos|Das|E)\b/g, x => x.toLowerCase());
function quedasAgora() {
  const g = geral.quedas;
  if (!g.ativo) return [];
  const desde = agora() - g.minutos * 60e3;
  while (semInternetRecentes.length && semInternetRecentes[0].ts < agora() - 6 * 3600e3) semInternetRecentes.shift();
  const mapa = new Map();
  const add = (bairro, cidade, jid, nome, ts, aberto) => {
    if (!bairro || !ts || ts < desde) return;
    const k = normTxt(bairro) + '|' + normTxt(cidade);
    let q = mapa.get(k);
    if (!q) mapa.set(k, q = { chave: k, bairro: capTxt(bairro), cidade: capTxt(cidade), clientes: new Map(), primeiro: ts, ultimo: ts });
    const atual = q.clientes.get(jid);
    q.clientes.set(jid, { jid, nome: capTxt(nome || ''), ts: Math.max(ts, atual?.ts || 0), aberto: aberto || atual?.aberto || false });
    q.primeiro = Math.min(q.primeiro, ts); q.ultimo = Math.max(q.ultimo, ts);
  };
  for (const r of semInternetRecentes) add(r.bairro, r.cidade, r.jid, r.nome, r.ts, false);
  for (const c of Object.values(db.chats)) {
    if (c.motivo !== 'sem_internet') continue;
    const cl = clienteAtual(c);
    add(cl?.bairro, cl?.cidade, c.jid, cl?.nome || c.name, c.motivoTs || c.inicio, c.status !== 'finalizado');
  }
  return [...mapa.values()].filter(q => q.clientes.size >= g.minimo)
    .map(q => ({ ...q, total: q.clientes.size, minutos: g.minutos, clientes: [...q.clientes.values()].sort((a, b) => b.ts - a.ts) }))
    .sort((a, b) => b.total - a.total || b.ultimo - a.ultimo);
}
let quedasAvisadas = new Map(); // chave -> total já avisado
let ultimasQuedas = '[]';
function verificarQuedas() {
  const lista = quedasAgora();
  const json = JSON.stringify(lista);
  if (json !== ultimasQuedas) { ultimasQuedas = json; io?.emit('quedas', lista); }
  const vistas = new Map();
  for (const q of lista) {
    vistas.set(q.chave, q.total);
    if (!quedasAvisadas.has(q.chave)) io?.emit('queda:nova', { bairro: q.bairro, cidade: q.cidade, total: q.total, minutos: q.minutos });
  }
  quedasAvisadas = vistas;
  return lista;
}
setInterval(verificarQuedas, 60e3).unref();

// Encerramento por inatividade: o cliente não respondeu depois da nossa última mensagem
setInterval(async () => {
  if (!geral.inatividade.ativo || state.status !== 'conectado') return;
  const limite = geral.inatividade.minutos * 60e3;
  for (const c of Object.values(db.chats)) {
    if (c.status !== 'andamento' && c.status !== 'automacao') continue;
    const ultima = [...c.msgs].reverse().find(m => !m.sys);
    if (!ultima || !ultima.fromMe || agora() - ultima.ts < limite) continue;
    await auto(c, geral.inatividade.texto);
    nota(c, `Encerrado por inatividade (${geral.inatividade.minutos} min sem resposta do cliente)`);
    await finalizar(c, 'Sistema', null, { semCsat: true });
  }
}, 60e3).unref();

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ erro: `Arquivo maior que ${MAX_MB} MB.` });
  res.status(500).json({ erro: err?.message || 'Erro interno' });
});

const server = http.createServer(app);
io = new Server(server, { maxHttpBufferSize: 1e6 });
io.use((s, next) => auth.usuarioDe(s.request) ? next() : next(new Error('login')));
io.on('connection', s => { const u = auth.usuarioDe(s.request); if (u) { s.join('u:' + u.id); s.data.uid = u.id; } s.emit('wa:status', state); });

if (process.env.IF_TESTE) {
  globalThis.__teste = { geral: () => geral, salvarGeral, dentroDoHorario, handleIncoming, responderIA, montarConversa, finalizar, relatorio, db, cfg, app, server, aoLigar, ligacoes, quedasAgora, verificarQuedas, definirMotivo, lerAnexo, chatOf, abrirAtendimento,
    set: (s, gerar) => { sock = s; if (gerar !== undefined) ia.gerar = gerar; state.status = 'conectado'; } };
} else {
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\n⚠️  A porta ${PORT} já está em uso. Provavelmente o NexoChat já está aberto em outra janela.`);
      console.log('   Feche a outra janela preta do NexoChat (ou ela será fechada sozinha na próxima tentativa).');
      process.exit(3);
    }
    throw e;
  });
  server.listen(PORT, () => {
    console.log(`\n🌐 NexoChat: http://localhost:${PORT}`);
    if (auth.precisaSetup()) console.log('👤 Primeiro acesso: abra o painel e crie o usuário administrador.');
    console.log(ENV_ARQUIVO ? `📄 Configuração lida do arquivo ${ENV_ARQUIVO}` : `⚠️  Não achei o arquivo .env na pasta ${ROOT}`);
    if (CHAVES_ARQUIVO) console.log('🔐 Chaves das IAs lidas do arquivo chaves.env');
    if (ENV_CHAVES_GRAVADAS.length) console.log('🔑 Chaves das IAs gravadas no .env: ' + ENV_CHAVES_GRAVADAS.join(', '));
    if (ia.gerar) verificarChaves().then(l => { ultimoTesteChaves = l; l.forEach(x => console.log('   ' + x)); }).catch(() => {});
    const chave = process.env[VAR_CHAVE] || '';
    console.log(chave ? `🔑 ${VAR_CHAVE} encontrada (${chave.slice(0, 4)}…${chave.slice(-4)}, ${chave.length} caracteres)` : `🔑 ${VAR_CHAVE} vazia ou ausente`);
    console.log(ia.gerar ? `🤖 IA: ${NOME_PROVEDOR} (modelo ${cfg.modelo})` : `🤖 IA desligada: coloque ${VAR_CHAVE} no arquivo .env`);
    console.log(sgp.sgpAtivo() ? '🔗 SGP conectado' : '🔗 SGP não configurado (SGP_URL, SGP_APP, SGP_TOKEN no .env)');
    startWA().catch(e => { console.error(e); setState({ status: 'erro' }); });
  });
}
