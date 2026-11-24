// Harness de simulação do index.html: extrai o <script>, roda num contexto vm
// com DOM e fetch falsos, e verifica os cenários dos bugs corrigidos.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('script nao encontrado');
const SCRIPT = m[1];

// O init roda no fim do script: separamos para poder injetar o relógio falso
// ANTES de a primeira consulta acontecer.
const CORTE = SCRIPT.indexOf('(function init() {');
if (CORTE < 0) throw new Error('init() nao encontrado');
const PARTE1 = SCRIPT.slice(0, CORTE);
const PARTE2 = SCRIPT.slice(CORTE);

let falhas = 0;
function check(nome, cond, extra) {
  if (cond) console.log('  OK    ' + nome);
  else { falhas++; console.log('  FALHA ' + nome + (extra !== undefined ? '  ->  ' + extra : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function flush(n = 8) { for (let i = 0; i < n; i++) await tick(); }

function stubEl(extra = {}) {
  let _inner = '';
  const el = {
    get innerHTML() { return _inner; },
    set innerHTML(v) { _inner = v; if (v === '') this.children.length = 0; },
    textContent: '', className: '', value: '', disabled: false,
    children: [], _listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    click(ev = { type: 'click' }) { (this._listeners.click || []).forEach(f => f(ev)); },
  };
  return Object.assign(el, extra);
}

// fetch falso com controle manual: 'pendurar' = nunca resolve (API travada)
function agendar(payloadFactory) {
  const fetchFalso = (url, opts) => new Promise((resolve, reject) => {
    const rec = { url, opts, resolve, reject };
    fetchFalso.chamadas.push(rec);
    const sinal = opts && opts.signal;
    if (sinal) sinal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    });
    if (payloadFactory === 'pendurar') return;
  });
  fetchFalso.chamadas = [];
  return fetchFalso;
}

function elenco() {
  const opts = ['hoje', '2', '3', '4', '5', '6', '7']
    .map(v => stubEl({ value: v, hidden: false, textContent: v }));
  const hojeOpt = opts[0];
  return {
    grid: stubEl(), status: stubEl(), hora: stubEl({ value: '08:00' }),
    dia: stubEl({
      value: 'hoje',
      querySelector: sel => (sel.includes('hoje') ? hojeOpt : null),
      querySelectorAll: () => opts,
    }),
    btnConsultar: stubEl(), btnAgora: stubEl(), btnAtualizar: stubEl(),
    nLivre: stubEl(), nOcup: stubEl(),
    _opcoes: opts, _hojeOpt: hojeOpt,
  };
}

function criarApp({ tempo, fetchFalso, timeoutReal = false }) {
  const els = elenco();
  const document = {
    getElementById: id => els[id],
    createElement: () => stubEl(),
    hidden: false,
    activeElement: null,
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
  };
  const intervalos = [];
  const ctx = {
    document, console, AbortController,
    fetch: fetchFalso || agendar(),
    // permite comprimir os timers para não esperar 12 s reais no teste de timeout
    setTimeout: (fn, ms) => setTimeout(fn, timeoutReal ? ms : Math.min(ms, 25)),
    clearTimeout: id => clearTimeout(id),
    // o relógio ao vivo é acionado à mão pelos testes (tiqueAoVivo), em vez de
    // deixar um setInterval real rodando enquanto a suíte executa
    setInterval: (fn, ms) => { intervalos.push({ fn, ms }); return intervalos.length; },
    clearInterval: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(PARTE1, ctx);
  if (tempo) vm.runInContext('agoraBrasilia = ' + tempo, ctx); // relógio falso
  vm.runInContext(PARTE2, ctx);
  return {
    ctx, els, document, intervalos,
    fetch: ctx.fetch,
    rodar: code => vm.runInContext(code, ctx),
  };
}

const DOMINGO = '() => ({ dia: 8, mes: 11, ano: 2026, hora: 10, minuto: 0 })';
const SEGUNDA = '() => ({ dia: 9, mes: 11, ano: 2026, hora: 10, minuto: 0 })';
const SEGUNDA_2359 = '() => ({ dia: 9, mes: 11, ano: 2026, hora: 23, minuto: 59 })';
const TERCA = '() => ({ dia: 10, mes: 11, ano: 2026, hora: 0, minuto: 1 })';

// payload: aula em dia2 (segunda) ou dia3 (terça)
function payload({ turma = 'CALCULO', label = '08:00h - 08:55h', dia = 2 } = {}) {
  const dias = {};
  for (let d = 2; d <= 7; d++) dias['dia' + d] = d === dia ? [{ label, turma }] : [];
  return { data: [dias] };
}

function responder(rec, corpo) {
  if (rec.__fechado) return;
  rec.__fechado = true;
  rec.resolve({ ok: true, status: 200, json: async () => corpo });
}
function falhar(rec, msg = 'HTTP 500') {
  if (rec.__fechado) return;
  rec.__fechado = true;
  rec.reject(new Error(msg));
}
async function responderTodas(app, corpo) {
  for (const c of app.fetch.chamadas) responder(c, corpo);
  await flush();
}

function cartaoDe(app, nome) {
  return app.els.grid.children.find(c => c.innerHTML.includes('>' + nome + '<'));
}

// ---------------------------------------------------------------- 1
console.log('\n1) Botoes travados no domingo');
{
  const app = criarApp({ tempo: DOMINGO, timeoutReal: true });
  await flush();
  check('domingo no init nao faz fetch', app.fetch.chamadas.length === 0, app.fetch.chamadas.length);
  check('botoes habilitados no domingo',
    !app.els.btnConsultar.disabled && !app.els.btnAgora.disabled && !app.els.btnAtualizar.disabled);

  app.els.dia.value = '2';
  const p1 = app.rodar('consultar()');
  await flush(2);
  check('dia util dispara 13 consultas', app.fetch.chamadas.length === 13, app.fetch.chamadas.length);
  check('botoes desabilitados durante a consulta',
    app.els.btnConsultar.disabled && app.els.btnAgora.disabled && app.els.btnAtualizar.disabled);

  app.els.dia.value = 'hoje'; // volta para domingo antes da resposta
  const p2 = app.rodar('consultar()');
  await flush(2);
  check('domingo: mensagem propria', app.els.status.textContent.includes('domingo'), app.els.status.textContent);
  check('domingo: botoes reabilitados',
    !app.els.btnConsultar.disabled && !app.els.btnAgora.disabled && !app.els.btnAtualizar.disabled);

  await responderTodas(app, payload());
  await Promise.all([p1, p2]);
  await flush();
  check('consulta obsoleta nao travou os botoes',
    !app.els.btnConsultar.disabled && !app.els.btnAgora.disabled);
}

// ---------------------------------------------------------------- 2
console.log('\n2) Cache contaminado na virada domingo -> segunda');
{
  const app = criarApp({ tempo: DOMINGO, timeoutReal: true });
  await flush();
  const p = app.rodar('carregarSala({ id: 27, nome: "Anf02" })');
  p.catch(() => {});
  await flush(2);
  app.rodar('agoraBrasilia = ' + SEGUNDA);
  responder(app.fetch.chamadas[0], payload({ turma: 'SEMANA VELHA' }));
  await flush();
  check('rebuscou sob a chave nova', app.fetch.chamadas.length === 2, app.fetch.chamadas.length);
  check('nao cacheou dado da semana antiga', app.rodar('Object.keys(cacheAgendas).join(",")') === '__dia',
    app.rodar('Object.keys(cacheAgendas).join(",")'));
  responder(app.fetch.chamadas[1], payload({ turma: 'SEMANA NOVA' }));
  await flush();
  const dados = await p;
  check('dado devolvido e o novo', dados && dados.dia2[0].turma === 'SEMANA NOVA', dados && dados.dia2[0].turma);
}

// ---------------------------------------------------------------- 3
console.log('\n3) Deduplicacao de fetch em voo');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  const antes = app.fetch.chamadas.length;
  app.rodar('consultar()');
  await flush(3);
  check('consulta sobreposta nao refaz o fetch', app.fetch.chamadas.length === antes,
    antes + ' -> ' + app.fetch.chamadas.length);
  await responderTodas(app, payload());
}

// ---------------------------------------------------------------- 4
console.log('\n4) Quem reaproveita requisicao em voo tambem valida a virada do dia');
{
  const app = criarApp({ tempo: DOMINGO, timeoutReal: true });
  await flush();
  const a = app.rodar('carregarSala({ id: 27, nome: "Anf02" })');
  await flush(2);
  const b = app.rodar('carregarSala({ id: 27, nome: "Anf02" })'); // reaproveita
  await flush(2);
  a.catch(() => {}); b.catch(() => {});
  check('a segunda chamada reaproveita a requisicao em voo', app.fetch.chamadas.length === 1,
    app.fetch.chamadas.length);

  app.rodar('agoraBrasilia = ' + SEGUNDA); // virou o dia
  responder(app.fetch.chamadas[0], payload({ turma: 'SEMANA VELHA' }));
  await flush();
  check('as duas rebuscam sob a chave nova (2 fetches)', app.fetch.chamadas.length === 2,
    app.fetch.chamadas.length);
  responder(app.fetch.chamadas[1], payload({ turma: 'SEMANA NOVA' }));
  await flush();
  const [da, db] = await Promise.all([a, b]);
  check('A devolve dado novo', da && da.dia2[0].turma === 'SEMANA NOVA', da && da.dia2[0].turma);
  check('B (que so reaproveitou) devolve dado novo', db && db.dia2[0].turma === 'SEMANA NOVA',
    db && db.dia2[0].turma);
}

// ---------------------------------------------------------------- 5
console.log('\n5) Timeout do fetch (API pendurada)');
{
  const app = criarApp({ tempo: SEGUNDA, fetchFalso: agendar('pendurar') });
  await flush(80);
  check('erro de tempo esgotado na tela',
    app.els.status.className.includes('error') && /tempo esgotado/.test(app.els.status.textContent),
    app.els.status.className + ' | ' + app.els.status.textContent);
  check('botoes reabilitados', !app.els.btnConsultar.disabled && !app.els.btnAtualizar.disabled);
  check('nenhuma requisicao pendurada em voo', app.rodar('Object.keys(requisicoesEmVoo).length') === 0,
    app.rodar('Object.keys(requisicoesEmVoo).length'));
}

// ---------------------------------------------------------------- 6
console.log('\n6) Fuso de Brasilia (processo em Asia/Tokyo)');
{
  process.env.TZ = 'Asia/Tokyo';
  const horaLocal = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  const app = criarApp({ tempo: null, timeoutReal: true });
  await flush();
  const esperado = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  check('"Agora" ignora Tóquio (' + horaLocal + ') e usa Brasilia',
    app.rodar('horaAgoraBrasilia()') === esperado, app.rodar('horaAgoraBrasilia()') + ' != ' + esperado);
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())) p[type] = value;
  const diaEsperado = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
  check('dia da semana de Brasilia', app.rodar('diaSemanaAgora()') === diaEsperado,
    app.rodar('diaSemanaAgora()') + ' != ' + diaEsperado);
  check('chave do cache ano-mes-dia', /^\d{4}-\d{1,2}-\d{1,2}$/.test(app.rodar('chaveDiaBrasilia()')),
    app.rodar('chaveDiaBrasilia()'));
  await responderTodas(app, payload());
  process.env.TZ = 'America/Sao_Paulo';
}

// ---------------------------------------------------------------- 7
console.log('\n7) Dados invalidos nao viram "sala vazia" nem derrubam o render');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  const corpo = id => {
    if (id === 27) return { data: [{ dia2: 'indisponivel', dia3: [] }] };
    if (id === 35) return { data: [{ dia2: [null], dia3: [] }] };
    if (id === 43) return { data: [{ get dia2() { throw new Error('boom'); }, dia3: [] }] };
    return payload();
  };
  for (const c of app.fetch.chamadas) responder(c, corpo(Number(c.url.split('id=')[1])));
  await flush();

  const cartoes = app.els.grid.children;
  check('13 cartoes renderizados mesmo com dados quebrados', cartoes.length === 13, cartoes.length);
  const porNome = n => cartoes.find(c => c.innerHTML.includes('>' + n + '<'));
  check('dia2 texto vira "Dados invalid", nao "Vazia"',
    porNome('Anf02').innerHTML.includes('Dados inv') && !porNome('Anf02').innerHTML.includes('Vazia'),
    porNome('Anf02').innerHTML.replace(/\s+/g, ' '));
  check('item null vira "Horario ilegivel"', porNome('Anf03').innerHTML.includes('ileg'),
    porNome('Anf03').innerHTML.replace(/\s+/g, ' '));
  check('getter que lanca vira "Nao foi possivel ler"', porNome('Anf04').innerHTML.includes('poss'),
    porNome('Anf04').innerHTML.replace(/\s+/g, ' '));
  check('as demais salas seguem sendo exibidas',
    cartoes.filter(c => c.className.includes('livre') || c.className.includes('ocupada')).length === 10,
    cartoes.map(c => c.className).join('|'));
  check('status avisa dos dados incompletos', app.els.status.textContent.includes('incompletos'),
    app.els.status.textContent);
  check('contadores nao contam as salas invalidas como vazias',
    app.els.nLivre.textContent === 10 && app.els.nOcup.textContent === 0,
    app.els.nLivre.textContent + '/' + app.els.nOcup.textContent);
}

// ---------------------------------------------------------------- 8
console.log('\n8) Erro limpa os resultados antigos da tela');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await responderTodas(app, payload());
  // init consultou com a hora do relogio falso (10:00); refaz as 08:00 (do cache)
  app.els.hora.value = '08:00';
  app.rodar('consultar()');
  await flush();
  check('consulta inicial mostrou 13 cartoes', app.els.grid.children.length === 13,
    app.els.grid.children.length);
  check('contadores preenchidos', app.els.nOcup.textContent === 13, app.els.nOcup.textContent);

  app.rodar('consultar(true)'); // forca nova busca
  await flush(3);
  for (const c of app.fetch.chamadas) falhar(c, 'HTTP 500');
  await flush();
  check('erro na tela', app.els.status.className.includes('error'), app.els.status.className);
  check('grid limpo (dado velho nao fica como se fosse atual)', app.els.grid.children.length === 0,
    app.els.grid.children.length);
  check('contadores voltam para "-"',
    app.els.nLivre.textContent === '–' && app.els.nOcup.textContent === '–',
    app.els.nLivre.textContent + '/' + app.els.nOcup.textContent);
}

// ---------------------------------------------------------------- 9
console.log('\n9) Cache expira (TTL) e "Atualizar" forca nova consulta');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await responderTodas(app, payload());
  const n1 = app.fetch.chamadas.length;
  check('13 fetches na primeira consulta', n1 === 13, n1);

  app.rodar('consultar()');
  await flush();
  check('dentro do TTL reaproveita o cache', app.fetch.chamadas.length === n1, app.fetch.chamadas.length);

  app.els.btnConsultar.click({ type: 'click' });
  await flush();
  check('clique em Consultar nao passa Event como "forcar"', app.fetch.chamadas.length === n1,
    app.fetch.chamadas.length);

  app.rodar('for (const k of Object.keys(cacheAgendas)) '
    + 'if (k !== "__dia" && cacheAgendas[k]) cacheAgendas[k].em -= 61000');
  app.rodar('consultar()');
  await flush();
  check('passado o TTL, refaz a busca', app.fetch.chamadas.length === n1 + 13,
    n1 + ' -> ' + app.fetch.chamadas.length);
  await responderTodas(app, payload());

  const n3 = app.fetch.chamadas.length;
  app.els.btnAtualizar.click({ type: 'click' });
  await flush(3);
  check('"Atualizar" ignora o cache', app.fetch.chamadas.length === n3 + 13,
    n3 + ' -> ' + app.fetch.chamadas.length);
  await responderTodas(app, payload());
}

// ---------------------------------------------------------------- 10
console.log('\n10) "Hoje" atravessando a meia-noite nao mistura dia e dados');
{
  const app = criarApp({ tempo: SEGUNDA_2359, timeoutReal: true });
  app.els.hora.value = '08:00';
  const p = app.rodar('consultar()');
  await flush(3);
  check('consulta comeca com 13 fetches', app.fetch.chamadas.length === 13, app.fetch.chamadas.length);

  app.rodar('agoraBrasilia = ' + TERCA); // meia-noite durante a consulta
  for (const c of app.fetch.chamadas.slice(0, 13)) responder(c, payload({ dia: 2, turma: 'SEGUNDA' }));
  await flush(6);
  check('refez a consulta sob o dia novo', app.fetch.chamadas.length === 26, app.fetch.chamadas.length);
  for (const c of app.fetch.chamadas.slice(13)) responder(c, payload({ dia: 3, turma: 'TERCA' }));
  await flush();
  await p;

  const cartoes = app.els.grid.children;
  check('renderizou a agenda de terca (dia3), coerente com o dia novo',
    cartoes.length === 13 && cartoes.every(c => c.innerHTML.includes('TERCA')),
    cartoes.map(c => (c.innerHTML.match(/<b>([^<]*)</) || [])[1]).join('|'));
  check('nao usou o dado de segunda com titulo de terca',
    cartoes.every(c => !c.innerHTML.includes('SEGUNDA')));
}

// ---------------------------------------------------------------- 11
console.log('\n11) Fluxo normal (segunda, 08:00, aula 08:00-08:55)');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await responderTodas(app, payload());
  app.els.hora.value = '08:00';
  app.rodar('consultar()');
  await flush();
  check('status de agenda', /Agenda de/.test(app.els.status.textContent), app.els.status.textContent);
  check('13 ocupadas, 0 vazias',
    app.els.nLivre.textContent === 0 && app.els.nOcup.textContent === 13,
    app.els.nLivre.textContent + '/' + app.els.nOcup.textContent);
  check('13 cartoes', app.els.grid.children.length === 13, app.els.grid.children.length);
  check('botoes habilitados', !app.els.btnConsultar.disabled && !app.els.btnAtualizar.disabled);
  check('sem refetch desnecessario', app.fetch.chamadas.length === 13, app.fetch.chamadas.length);
}

// ---------------------------------------------------------------- 12
console.log('\n12) Blocos consecutivos da mesma turma sao fundidos');
{
  // ordem propositalmente invertida: a API nao ordena por horario
  const lista = [
    { label: '08:55h - 09:50h', turma: 'MAT0026| Turma: 06' },
    { label: '08:00h - 08:55h', turma: 'MAT0026| Turma: 06' },
  ];
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  for (const c of app.fetch.chamadas) responder(c, { data: [{ dia2: lista, dia3: [] }] });
  await flush();
  app.els.hora.value = '08:20';
  app.rodar('consultar()');
  await flush();
  const cartao = cartaoDe(app, 'Anf02');
  check('mostra a aula inteira (08:00h - 09:50h)', cartao.innerHTML.includes('08:00h - 09:50h'),
    cartao.innerHTML.replace(/\s+/g, ' '));
  check('nao anuncia fim na metade da aula', !cartao.innerHTML.includes('08:00h - 08:55h'));
  check('sinaliza que fundiu dois registros', cartao.innerHTML.includes('(2 aulas)'),
    cartao.innerHTML.replace(/\s+/g, ' '));
}

// ---------------------------------------------------------------- 13
console.log('\n13) Reserva longa sobreposta nao e escondida pelas aulas');
{
  // caso real da Anf16 (dia4): aulas regulares + evento 08:00h - 22:40h
  const lista = [
    { label: '08:00h - 08:55h', turma: 'MAT0025| Turma: 21' },
    { label: '08:55h - 09:50h', turma: 'MAT0025| Turma: 21' },
    { label: '08:00h - 22:40h', turma: 'CPOP| Turma: -' },
  ];
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  for (const c of app.fetch.chamadas) responder(c, { data: [{ dia2: lista, dia3: [] }] });
  await flush();
  app.els.hora.value = '09:30';
  app.rodar('consultar()');
  await flush();
  const html = cartaoDe(app, 'Anf02').innerHTML.replace(/\s+/g, ' ');
  check('mostra o evento que segura a sala ate 22:40', html.includes('CPOP') && html.includes('22:40h'), html);
  check('nao faz parecer que a sala libera as 09:50', !/Livre at|Pr.xima/.test(html), html);
  check('avisa das reservas simultaneas', html.includes('no mesmo horário'), html);
}

// ---------------------------------------------------------------- 14
console.log('\n14) Turmas diferentes encadeadas avisam ate quando a sala segue ocupada');
{
  const lista = [
    { label: '08:00h - 08:55h', turma: 'MAT0026| Turma: 06' },
    { label: '08:55h - 09:50h', turma: 'MAT0025| Turma: 07' },
  ];
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  for (const c of app.fetch.chamadas) responder(c, { data: [{ dia2: lista, dia3: [] }] });
  await flush();
  app.els.hora.value = '08:20';
  app.rodar('consultar()');
  await flush();
  const html = cartaoDe(app, 'Anf02').innerHTML.replace(/\s+/g, ' ');
  check('mostra a reserva atual', html.includes('08:00h - 08:55h'), html);
  check('avisa que segue ocupada ate 09:50', html.includes('Ocupada até 09:50'), html);
}

// ---------------------------------------------------------------- 15
console.log('\n15) Turmas simultaneas no mesmo horario');
{
  const lista = [
    { label: '19:00h - 19:50h', turma: 'MAT0025| Turma: 07' },
    { label: '19:00h - 19:50h', turma: 'MAT0025| Turma: 08' },
    { label: '19:00h - 19:50h', turma: 'MAT0025| Turma: 09' },
  ];
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  for (const c of app.fetch.chamadas) responder(c, { data: [{ dia2: lista, dia3: [] }] });
  await flush();
  app.els.hora.value = '19:00';
  app.rodar('consultar()');
  await flush();
  const html = cartaoDe(app, 'Anf02').innerHTML.replace(/\s+/g, ' ');
  check('conta as turmas simultaneas', html.includes('+2 reserva(s) no mesmo horário'), html);
  check('continua marcada como ocupada', html.includes('Ocupada'), html);
}

// ---------------------------------------------------------------- 16
console.log('\n16) Seletor de dia remove a opcao duplicada do DOM (iOS/Safari)');
{
  const QUINTA = '() => ({ dia: 12, mes: 11, ano: 2026, hora: 9, minuto: 0 })';
  const app = criarApp({ tempo: QUINTA, timeoutReal: true });
  await flush();
  const valores = app.els.dia.children.map(o => o.value);
  const rotulo = app.els.dia.children[0].textContent;
  check('"Hoje" mostra o dia real', rotulo === 'Hoje · Quinta', rotulo);
  check('a opcao de quinta-feira nao existe no DOM (hidden nao basta no WebKit)',
    !valores.includes('5'), valores.join(','));
  check('as demais opcoes continuam', ['hoje', '2', '3', '4', '6', '7'].every(v => valores.includes(v)),
    valores.join(','));
  check('selecao preservada', app.els.dia.value === 'hoje', app.els.dia.value);
  await responderTodas(app, payload());
}

// ---------------------------------------------------------------- 17
console.log('\n17) Aba aberta na virada da meia-noite atualiza o rotulo do seletor');
{
  const QUINTA = '() => ({ dia: 12, mes: 11, ano: 2026, hora: 21, minuto: 0 })';
  const SEXTA = '() => ({ dia: 13, mes: 11, ano: 2026, hora: 7, minuto: 0 })';
  const app = criarApp({ tempo: QUINTA, timeoutReal: true });
  await flush();
  check('antes da virada: Hoje · Quinta', app.els.dia.children[0].textContent === 'Hoje · Quinta',
    app.els.dia.children[0].textContent);
  app.rodar('agoraBrasilia = ' + SEXTA);
  app.rodar('consultar()');
  await flush(3);
  const valores = app.els.dia.children.map(o => o.value);
  check('depois da virada: Hoje · Sexta', app.els.dia.children[0].textContent === 'Hoje · Sexta',
    app.els.dia.children[0].textContent);
  check('sexta-feira nao aparece duplicada', !valores.includes('6'), valores.join(','));
  check('quinta-feira volta a aparecer', valores.includes('5'), valores.join(','));
  await responderTodas(app, payload());
}

// ---------------------------------------------------------------- 18
console.log('\n18) Falha parcial mantem o card da sala na grade');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await responderTodas(app, payload());
  app.els.hora.value = '08:00';
  app.rodar('consultar()'); // do cache, sem fetch
  await flush();
  check('consulta inicial: 13 ocupadas', app.els.nOcup.textContent === 13, app.els.nOcup.textContent);

  const antes = app.fetch.chamadas.length;
  app.rodar('consultar(true)'); // forca nova busca
  await flush(3);
  for (const c of app.fetch.chamadas.slice(antes)) {
    if (c.url.endsWith('id=27')) falhar(c, 'HTTP 503');
    else responder(c, payload());
  }
  await flush();
  const cartoes = app.els.grid.children;
  check('13 cartoes mesmo com uma sala falhando', cartoes.length === 13, cartoes.length);
  const ruim = cartaoDe(app, 'Anf02');
  check('card da sala com erro aparece marcado', !!ruim && ruim.innerHTML.includes('Sem resposta'),
    ruim && ruim.innerHTML.replace(/\s+/g, ' '));
  check('o motivo do erro fica visivel', ruim.innerHTML.includes('HTTP 503'), ruim.innerHTML);
  check('as outras 12 seguem contando', app.els.nOcup.textContent === 12, app.els.nOcup.textContent);
  check('status separa "sem resposta"', app.els.status.textContent.includes('1 sem resposta'),
    app.els.status.textContent);
}

// ---------------------------------------------------------------- 19
console.log('\n19) HTTP 200 com success=false nao entra no cache como "sem agenda"');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await flush();
  for (const c of app.fetch.chamadas) {
    if (c.url.endsWith('id=27')) {
      responder(c, { success: false, status: 500, error: 'boom no backend', data: [] });
    } else {
      responder(c, payload());
    }
  }
  await flush();
  const cartao = cartaoDe(app, 'Anf02');
  check('sala marcada como sem resposta', cartao.innerHTML.includes('Sem resposta'), cartao.innerHTML);
  check('motivo do backend aparece', cartao.innerHTML.includes('boom no backend'), cartao.innerHTML);
  check('nada foi cacheado para a sala', app.rodar('cacheAgendas[27] === undefined') === true,
    app.rodar('JSON.stringify(cacheAgendas[27])'));

  // e a proxima consulta tenta de novo
  const antes = app.fetch.chamadas.length;
  app.rodar('consultar()');
  await flush(3);
  check('proxima consulta tenta a sala de novo', app.fetch.chamadas.length === antes + 1,
    antes + ' -> ' + app.fetch.chamadas.length);
  await responderTodas(app, payload());
}

// ---------------------------------------------------------------- 20
console.log('\n20) Campo de horario vazio nao e sobrescrito');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await responderTodas(app, payload());
  const antes = app.fetch.chamadas.length;
  const cartoesAntes = app.els.grid.children.length;

  app.els.hora.value = '';
  app.els.hora._listeners.change[0](); // blur com o campo vazio
  await flush();

  check('campo continua vazio (nao volta para "agora")', app.els.hora.value === '',
    JSON.stringify(app.els.hora.value));
  check('nada de consulta com horario inventado', app.fetch.chamadas.length === antes,
    antes + ' -> ' + app.fetch.chamadas.length);
  check('grade anterior continua na tela', app.els.grid.children.length === cartoesAntes,
    app.els.grid.children.length);
  check('status pede um horario valido', /HH:MM/.test(app.els.status.textContent),
    app.els.status.textContent);

  app.els.hora.value = '19:00';
  app.els.hora._listeners.change[0]();
  await flush();
  check('ao digitar de novo, consulta o horario digitado',
    app.els.status.textContent.includes('às 19:00'), app.els.status.textContent);
}

// ---------------------------------------------------------------- 21
console.log('\n21) Trocar o dia no seletor atualiza a grade sem clique em Consultar');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  const dias = {};
  for (let d = 2; d <= 7; d++) dias['dia' + d] = [];
  dias.dia2 = [{ label: '08:00h - 08:55h', turma: 'SEGUNDA' }];
  dias.dia6 = [{ label: '08:00h - 08:55h', turma: 'SEXTA' }];
  await responderTodas(app, { data: [dias] });
  app.els.hora.value = '08:00';
  app.rodar('consultar()');
  await flush();
  check('grade inicial mostra segunda', app.els.grid.children[0].innerHTML.includes('SEGUNDA'));

  const antes = app.fetch.chamadas.length;
  app.els.dia.value = '6'; // sexta-feira
  app.els.dia._listeners.change[0](); // evento change do usuário
  await flush(3);
  check('grade muda para sexta sem clicar em Consultar',
    app.els.grid.children[0].innerHTML.includes('SEXTA'),
    app.els.grid.children[0].innerHTML.replace(/\s+/g, ' '));
  check('usa o cache (nao refaz os 13 fetches)', app.fetch.chamadas.length === antes,
    antes + ' -> ' + app.fetch.chamadas.length);
  check('status fala de sexta', app.els.status.textContent.includes('Agenda de Sexta'),
    app.els.status.textContent);
}

// ---------------------------------------------------------------- 22
console.log('\n22) Status descreve o dia que foi consultado, nao o que ficou selecionado');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  app.els.hora.value = '08:00';
  app.els.dia.value = '6'; // sexta selecionada
  const p = app.rodar('consultar()');
  await flush(3);
  app.els.dia.value = 'hoje'; // usuário volta para "Hoje" com a consulta em voo
  for (const c of app.fetch.chamadas) responder(c, payload({ dia: 6, turma: 'SEXTA' }));
  await flush();
  await p;
  check('titulo fala de sexta (o que foi consultado)',
    app.els.status.textContent.includes('Agenda de Sexta'), app.els.status.textContent);
  check('grade e sexta', app.els.grid.children[0].innerHTML.includes('SEXTA'),
    app.els.grid.children[0].innerHTML.replace(/\s+/g, ' '));
}

// ---------------------------------------------------------------- 23
console.log('\n23) Proxima aula sem turma nao rende <b> vazio');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true }); // 10:00
  await flush();
  const dias = { dia2: [{ label: '11:00h - 11:50h' }], dia3: [] }; // sem turma
  for (const c of app.fetch.chamadas) responder(c, { data: [dias] });
  await flush();
  const html = cartaoDe(app, 'Anf02').innerHTML.replace(/\s+/g, ' ');
  check('mostra o texto de fallback', html.includes('Turma não especificada'), html);
  check('nao deixa a tag de negrito vazia', !html.includes('<b></b>'), html);
}

// ---------------------------------------------------------------- 24
console.log('\n24) Relogio ao vivo: o minuto vira e a tela acompanha sozinha');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true }); // 10:00
  const dias = { dia2: [{ label: '10:00h - 10:50h', turma: 'MAT0025| Turma: 21' }], dia3: [] };
  for (const c of app.fetch.chamadas) responder(c, { data: [dias] });
  await flush();
  check('inicio no horario atual', app.els.hora.value === '10:00', app.els.hora.value);
  check('inicio ocupada ate 10:50',
    cartaoDe(app, 'Anf02').innerHTML.includes('10:00h - 10:50h'));

  app.rodar('agoraBrasilia = () => ({ dia: 9, mes: 11, ano: 2026, hora: 10, minuto: 51 })');
  app.rodar('tiqueAoVivo()');
  await flush();

  check('campo avancou para 10:51', app.els.hora.value === '10:51', app.els.hora.value);
  check('sala virou vazia sem F5', cartaoDe(app, 'Anf02').innerHTML.includes('Vazia'),
    cartaoDe(app, 'Anf02').innerHTML.replace(/\s+/g, ' '));
  check('status acompanhou o relogio', app.els.status.textContent.includes('às 10:51'),
    app.els.status.textContent);
  check('atualizacao silenciosa nao travou os botoes',
    !app.els.btnConsultar.disabled && !app.els.btnAtualizar.disabled);
  check('reaproveitou o cache (nenhum fetch novo)', app.fetch.chamadas.length === 13,
    app.fetch.chamadas.length);
}

// ---------------------------------------------------------------- 25
console.log('\n25) Modo ao vivo nao sobrescreve escolha manual');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true }); // 10:00
  await responderTodas(app, payload());

  app.els.hora.value = '14:00';
  app.els.hora._listeners.change[0]();
  await flush();
  app.rodar('agoraBrasilia = () => ({ dia: 9, mes: 11, ano: 2026, hora: 10, minuto: 30 })');
  app.rodar('tiqueAoVivo()');
  await flush();
  check('horario manual preservado', app.els.hora.value === '14:00', app.els.hora.value);

  app.els.dia.value = '6';
  app.els.dia._listeners.change[0]();
  await flush();
  app.rodar('tiqueAoVivo()');
  await flush();
  check('dia escolhido preservado', app.els.dia.value === '6', app.els.dia.value);
  check('horario continua o do usuario', app.els.hora.value === '14:00', app.els.hora.value);
}

// ---------------------------------------------------------------- 26
console.log('\n26) Relogio nao disputa o campo com quem esta digitando');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true });
  await responderTodas(app, payload());
  app.document.activeElement = app.els.hora;
  app.els.hora.value = '';
  app.rodar('agoraBrasilia = () => ({ dia: 9, mes: 11, ano: 2026, hora: 10, minuto: 45 })');
  app.rodar('tiqueAoVivo()');
  await flush();
  check('campo em edicao nao e tocado', app.els.hora.value === '', JSON.stringify(app.els.hora.value));

  app.document.activeElement = null;
  app.rodar('tiqueAoVivo()');
  await flush();
  check('ao sair do campo o relogio retoma', app.els.hora.value === '10:45', app.els.hora.value);
}

// ---------------------------------------------------------------- 27
console.log('\n27) Falha da atualizacao automatica nao apaga a tela');
{
  const app = criarApp({ tempo: SEGUNDA, timeoutReal: true }); // 10:00
  await responderTodas(app, payload());
  check('tela inicial com 13 cartoes', app.els.grid.children.length === 13,
    app.els.grid.children.length);

  app.rodar('for (const k of Object.keys(cacheAgendas)) '
    + 'if (k !== "__dia" && cacheAgendas[k]) cacheAgendas[k].em -= 61000'); // vence o TTL
  app.rodar('agoraBrasilia = () => ({ dia: 9, mes: 11, ano: 2026, hora: 10, minuto: 5 })');
  const antes = app.fetch.chamadas.length;
  app.rodar('tiqueAoVivo()');
  await flush(3);
  check('tentou atualizar as 13 salas', app.fetch.chamadas.length === antes + 13,
    antes + ' -> ' + app.fetch.chamadas.length);

  for (const c of app.fetch.chamadas.slice(antes)) falhar(c, 'HTTP 500');
  await flush();
  check('grade preservada em vez de ficar vazia', app.els.grid.children.length === 13,
    app.els.grid.children.length);
  check('erro visivel', app.els.status.className.includes('error')
    && app.els.status.textContent.includes('Falha ao atualizar'), app.els.status.textContent);
  check('campo volta ao horario dos cartoes', app.els.hora.value === '10:00', app.els.hora.value);

  const bloq = app.fetch.chamadas.length;
  app.rodar('tiqueAoVivo()');
  await flush();
  check('nao martela a API durante a falha', app.fetch.chamadas.length === bloq,
    bloq + ' -> ' + app.fetch.chamadas.length);
}

// ---------------------------------------------------------------- 28
console.log('\n28) Virada do dia atualiza o seletor mesmo no modo manual');
{
  const TERCA_2359 = '() => ({ dia: 24, mes: 11, ano: 2026, hora: 23, minuto: 59 })';
  const QUARTA_0010 = '() => ({ dia: 25, mes: 11, ano: 2026, hora: 0, minuto: 10 })';
  const app = criarApp({ tempo: TERCA_2359, timeoutReal: true });
  await flush();
  await responderTodas(app, payload({ dia: 3 }));

  app.els.hora.value = '20:00'; // horário escolhido: modo ao vivo desligado
  app.els.hora._listeners.change[0]();
  await flush();
  const rotuloAntes = app.els.dia.children[0].textContent;

  app.rodar('agoraBrasilia = ' + QUARTA_0010);
  app.rodar('tiqueAoVivo()');
  await flush();

  const valores = app.els.dia.children.map(o => o.value);
  check('antes da virada: Hoje · Terça', rotuloAntes === 'Hoje · Terça', rotuloAntes);
  check('depois da virada: Hoje · Quarta',
    app.els.dia.children[0].textContent === 'Hoje · Quarta', app.els.dia.children[0].textContent);
  check('terça-feira reaparece na lista', valores.includes('3'), valores.join(','));
  check('quarta-feira sai da lista duplicada', !valores.includes('4'), valores.join(','));
  check('horario escolhido pelo usuario preservado', app.els.hora.value === '20:00',
    app.els.hora.value);
}

console.log(falhas ? '\n' + falhas + ' verificacao(oes) falharam' : '\nTodos os cenarios passaram');
process.exit(falhas ? 1 : 0);
