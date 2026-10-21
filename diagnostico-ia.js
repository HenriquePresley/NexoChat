// Diagnóstico da IA: testa a chave e vários modelos gratuitos, e mostra qual está respondendo agora.
// Uso: npm run testar-ia
import fs from 'node:fs';
import path from 'node:path';
import { ENV_ARQUIVO, ROOT } from './src/config.js';

const env = process.env;
const cfgSalva = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'dados', 'config.json'), 'utf8')).ia || {}; } catch { return {}; } })();
const provedor = (env.IA_PROVEDOR || (env.GEMINI_API_KEY ? 'gemini' : env.GROQ_API_KEY ? 'groq' : env.OPENAI_API_KEY ? 'openai' : 'gemini')).toLowerCase();

console.log(`\n📄 Arquivo de configuração: ${ENV_ARQUIVO || 'NÃO ENCONTRADO'} (pasta ${ROOT})`);
console.log(`🤖 Provedor: ${provedor}`);
if (cfgSalva.modelo) console.log(`💾 Modelo salvo no painel (Prompts da IA): ${cfgSalva.modelo} · reserva: ${cfgSalva.modeloReserva || '—'}`);
if (env.IA_MODELO) console.log(`📝 Modelo no .env: ${env.IA_MODELO}`);

const linha = (m, ok, ms, txt) => console.log(`${ok ? '✅' : '❌'} ${m.padEnd(28)} ${String(ms).padStart(6)} ms  ${txt}`);

async function gemini() {
  const KEY = env.GEMINI_API_KEY;
  if (!KEY) return console.log('❌ GEMINI_API_KEY vazia. Coloque a chave no .env.');
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  let disponiveis = [];
  try {
    const r = await fetch(`${base}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': KEY } });
    const j = await r.json();
    if (!r.ok) { console.log(`❌ A chave foi recusada: HTTP ${r.status} · ${j.error?.message || ''}`); return; }
    disponiveis = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', ''));
    console.log(`🔑 Chave aceita. Modelos de texto liberados para ela: ${disponiveis.length}\n`);
  } catch (e) { console.log('❌ Sem conexão com o Google:', e.message); return; }
  const candidatos = [...new Set([cfgSalva.modelo, cfgSalva.modeloReserva, env.IA_MODELO, env.IA_MODELO_RESERVA,
    'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest',
    ...disponiveis.filter(m => /flash/i.test(m) && !/image|tts|live|audio|embed/i.test(m))].filter(Boolean))].slice(0, 14);
  const funcionando = [];
  for (const m of candidatos) {
    const t = Date.now();
    try {
      const r = await fetch(`${base}/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Responda apenas: OK' }] }], generationConfig: { maxOutputTokens: 400 } })
      });
      const j = await r.json().catch(() => ({}));
      const ms = Date.now() - t;
      if (r.ok) { funcionando.push([m, ms]); linha(m, true, ms, (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text).join('').trim().slice(0, 30)); }
      else linha(m, false, ms, `HTTP ${r.status} · ${(j.error?.message || '').slice(0, 90)}`);
    } catch (e) { linha(m, false, Date.now() - t, e.message); }
  }
  sugestao(funcionando);
}

async function compativelOpenAI(nome, KEY, baseURL, modelos) {
  if (!KEY) return console.log(`❌ Chave do ${nome} vazia no .env.`);
  const funcionando = [];
  for (const m of [...new Set([cfgSalva.modelo, env.IA_MODELO, ...modelos].filter(Boolean))]) {
    const t = Date.now();
    try {
      const r = await fetch(`${baseURL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Responda apenas: OK' }], max_completion_tokens: 300 }) });
      const j = await r.json().catch(() => ({}));
      const ms = Date.now() - t;
      if (r.ok) { funcionando.push([m, ms]); linha(m, true, ms, String(j.choices?.[0]?.message?.content || '').trim().slice(0, 30)); }
      else linha(m, false, ms, `HTTP ${r.status} · ${(j.error?.message || '').slice(0, 90)}`);
    } catch (e) { linha(m, false, Date.now() - t, e.message); }
  }
  sugestao(funcionando);
}

function sugestao(ok) {
  console.log('');
  if (!ok.length) {
    console.log('⚠️  Nenhum modelo respondeu agora. Se todos deram "overloaded/high demand" (503), o plano gratuito está congestionado:');
    console.log('    tente de novo em alguns minutos, ative o faturamento no Google AI Studio, ou use o Groq (gratuito):');
    console.log('    no .env coloque IA_PROVEDOR=groq e GROQ_API_KEY=sua-chave (crie em https://console.groq.com/keys).');
    return;
  }
  ok.sort((a, b) => a[1] - b[1]);
  console.log(`👉 Use no painel (Prompts da IA): Modelo = ${ok[0][0]}${ok[1] ? `  ·  Reserva = ${ok[1][0]}` : ''}`);
}

if (provedor === 'gemini') await gemini();
else if (provedor === 'groq') await compativelOpenAI('Groq', env.GROQ_API_KEY, 'https://api.groq.com/openai/v1', ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
else if (provedor === 'openai') await compativelOpenAI('ChatGPT', env.OPENAI_API_KEY, 'https://api.openai.com/v1', ['gpt-5-mini', 'gpt-5-nano']);
else console.log('Diagnóstico disponível para gemini, groq e openai.');
console.log('');
