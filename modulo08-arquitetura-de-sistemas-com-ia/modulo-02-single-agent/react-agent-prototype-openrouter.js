/**
 * Ahirton Lopes · AI Architecture Toolkit
 * Artefato de Demo - Módulo 2.5
 *
 * Protótipo: Agente único do TrialForge (geração da seção de assentimento do ICF)
 * Padrão: loop ReAct (Módulo 2.2) + ferramenta com schema tipado (Módulo 2.4)
 * Sem fila de mensagens — isso fica para o Módulo 3 (multi-agente).
 *
 * ESTA É A VARIANTE OpenRouter deste protótipo. O original (react-agent-prototype.js)
 * roda com Ollama local; aqui a MESMA arquitetura fala com a OpenRouter usando a SDK
 * `openai`, no formato do chamarGPT() de provedores-pagos.js. É a lição do diagrama de
 * referência do Módulo 1.2 na prática: o modelo é a única peça que se troca —
 * Orquestrador, ferramenta e critério de parada são byte a byte os mesmos.
 *
 * Por que a SDK da OpenAI aponta pra OpenRouter: a OpenRouter expõe uma API
 * compatível com a Chat Completions da OpenAI. Trocar só a baseURL e a chave já
 * basta — e com isso você ganha acesso a modelos de vários provedores (OpenAI,
 * Anthropic, Google, Meta...) por trás de uma única interface. Sim, é exatamente
 * o mesmo problema de fragmentação que o MCP (Módulo 2.4) resolve para ferramentas,
 * resolvido aqui na camada de modelo por um gateway.
 *
 * Trade-off em relação ao Ollama local (TP do Módulo 2.5): a OpenRouter custa por
 * token, exige rede e manda o prompt para fora da sua máquina (importa, num domínio
 * com dado clínico), mas em troca dá qualidade de modelo de fronteira e nenhum
 * download de 7GB. Prototipagem: escolha livre. Produção (Módulo 5): a decisão
 * pesaria conformidade e residência de dados, não conveniência.
 *
 * Requer: 1) npm install openai
 *         2) um arquivo .env nesta mesma pasta, com a chave da OpenRouter:
 *              OPENROUTER_API_KEY=sk-or-v1-...
 *            (opcional) escolher outro modelo, na mesma linha de raciocínio:
 *              OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
 *            O .env já está no .gitignore do repositório — confira antes de commitar,
 *            porque chave versionada é chave queimada.
 * Uso:    node react-agent-prototype-openrouter.js
 */

const path = require('path');
const OpenAI = require('openai');

// ---------- Carregamento do .env ----------
// process.loadEnvFile() é nativo do Node (>= 20.12) — sem dependência de `dotenv`.
// Dois detalhes que valem a explicação:
//   1) Resolvemos por __dirname, não pelo diretório de onde você chamou `node`. Assim o
//      arquivo acha o .env dele mesmo, seja qual for o seu cwd.
//   2) Variável já definida no ambiente VENCE a do arquivo (comportamento do próprio
//      Node). É a precedência que você quer: em produção (Módulo 5) a chave vem do
//      cofre de segredos da plataforma, e o .env é só a conveniência de quem está
//      prototipando na própria máquina — um nunca atropela o outro.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // .env ausente não é erro fatal aqui: a chave pode ter vindo direto do ambiente.
  // Se não veio de lugar nenhum, a checagem logo abaixo é que reclama, com instrução.
}

const MAX_ITERACOES = 4;

// Catálogo completo e preços em https://openrouter.ai/models — o modelo tem que
// suportar tool calling, senão o loop ReAct nunca sai da primeira volta.
const MODELO = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

// Chave lida do .env ou do ambiente, jamais escrita no código: segredo dentro de
// arquivo versionado vaza no primeiro `git push`. Falhar aqui e agora, com instrução
// clara, é melhor que um 401 opaco no meio da terceira volta do loop.
const CHAVE = process.env.OPENROUTER_API_KEY;
if (!CHAVE) {
  console.error('[Configuração] OPENROUTER_API_KEY não encontrada no .env nem no ambiente.');
  console.error(`  Esperado em: ${path.join(__dirname, '.env')}`);
  console.error('  Conteúdo:    OPENROUTER_API_KEY=sk-or-v1-...   (pegue a chave em openrouter.ai/keys)');
  process.exit(1);
}

const cliente = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: CHAVE,
  // A SDK da OpenAI já reexecuta a chamada 2x por conta própria por padrão. Desligamos
  // isso: o retry didático deste arquivo (chamarModeloComRetry) tem que ser o único,
  // ou você vê "1 tentativa" no log e 3 cobranças na fatura.
  maxRetries: 0,
  // Cabeçalhos opcionais da OpenRouter — aparecem nos rankings públicos deles e
  // ajudam a identificar a origem do tráfego na sua conta.
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/unipds-engenharia-de-ia-aplicada',
    'X-Title': 'TrialForge ICF Agent (UNIPDS Módulo 2.5)',
  },
});

// Ferramenta tipada (Módulo 2.4): schema explícito, nunca texto livre.
// Idêntico ao do protótipo Ollama e ao toolGPT de provedores-pagos.js — a forma
// aninhada (`function: {...}`) é a mesma nos dois, então nada muda aqui.
const buscarClausulaRegulatoria = {
  type: 'function',
  function: {
    name: 'buscar_clausula_regulatoria',
    description:
      'Busca cláusulas regulatórias de estudos clínicos por tema e jurisdição. Use quando precisar de texto normativo (ANVISA ou FDA) para compor uma seção do documento.',
    parameters: {
      type: 'object',
      properties: {
        tema: { type: 'string' },
        jurisdicao: { type: 'string', enum: ['ANVISA', 'FDA'] },
      },
      required: ['tema', 'jurisdicao'],
    },
  },
};

// Execução real da ferramenta — sempre determinística, nunca é o modelo quem executa.
// Busca por palavra-chave, não string exata: o modelo formula o "tema" em linguagem
// natural (ex.: "Assentimento para menores de idade em estudos clínicos"), então a
// busca real por trás dessa ferramenta seria vetorial (RAG, Módulo 1.2/2.2) — aqui
// simulamos isso com um match por palavra-chave em vez de comparação exata.
async function executarBuscaClausula(argumentosBrutos) {
  const { tema, jurisdicao } = argumentosBrutos || {};

  // O modelo às vezes formula a chamada com um parâmetro faltando ou grafado errado
  // (testado de verdade: já vimos "jurisdicicao" em vez de "jurisdicao"). Validar aqui,
  // em vez de confiar cegamente, evita um crash silencioso ou um resultado errado por
  // undefined escapar sem ninguém perceber — a ferramenta trata isso como falha própria,
  // não deixa o erro estourar pro chamador.
  if (typeof tema !== 'string' || typeof jurisdicao !== 'string') {
    return {
      texto: null,
      fonte: null,
      aviso: `parâmetro inválido ou ausente na chamada da ferramenta: ${JSON.stringify(argumentosBrutos)}`,
    };
  }

  const temaNormalizado = tema.toLowerCase();
  // Testado de verdade: o modelo às vezes formula o tema com "adolescente" ou
  // "pediátrico" em vez de "menor" — um match de palavra única era frágil demais
  // pra depender da sorte da frase exata que o modelo escolhe.
  const mencionaMenorDeIdade = ['menor', 'adolescente', 'pediátric'].some((palavra) =>
    temaNormalizado.includes(palavra)
  );

  if (jurisdicao === 'ANVISA' && mencionaMenorDeIdade) {
    return {
      texto:
        'Para participantes entre 12 e 17 anos, é necessário assentimento por escrito, ' +
        'além do consentimento do responsável legal (RDC ANVISA 466/2012, Art. 4º).',
      fonte: 'RDC ANVISA 466/2012, Art. 4º',
    };
  }

  return {
    texto: null,
    fonte: null,
    aviso: `não encontrado: nenhuma cláusula sobre "${tema}" na jurisdição ${jurisdicao}. Tente outra jurisdição ou revise o tema.`,
  };
}

// ---------- Diferença de formato nº 1: argumentos vêm como STRING ----------
// O Ollama devolve `arguments` já como objeto JavaScript. A API da OpenAI (e portanto a
// OpenRouter) devolve uma STRING de JSON, que o modelo gerou token a token — ou seja,
// pode vir truncada ou mal formada. JSON.parse cru aqui derrubaria o loop inteiro por
// causa de uma vírgula sobrando. Retornamos null e deixamos executarBuscaClausula
// tratar como falha própria da ferramenta, exatamente como faz com parâmetro errado.
function parsearArgumentos(argumentosCrus) {
  if (argumentosCrus && typeof argumentosCrus === 'object') return argumentosCrus; // já veio parseado
  if (typeof argumentosCrus !== 'string' || argumentosCrus.trim() === '') return null;
  try {
    const parseado = JSON.parse(argumentosCrus);
    return parseado && typeof parseado === 'object' ? parseado : null;
  } catch {
    return null;
  }
}

// ---------- Testes automatizados da ferramenta (determinística, sem chamar o modelo) ----------
// Mesma disciplina do Módulo 1.3 (decision-framework-tool.js): o que é determinístico no nosso
// próprio código ganha teste automatizado; a redação exata do modelo, e se ele decide chamar a
// ferramenta ou não, fica pra observação ao vivo em simularInteracao(), não pra assert aqui.
// Estes casos cobrem os dois bugs reais encontrados testando contra o modelo de verdade:
// a grafia "jurisdicicao" (parâmetro mal formado) e o tema formulado com "adolescente"/
// "pediátrico" em vez de "menor".
const CASOS_TESTE_FERRAMENTA = [
  { tema: 'Assentimento para menores de idade em estudos clínicos', jurisdicao: 'ANVISA', esperaAchar: true },
  { tema: 'Consentimento de adolescentes em pesquisa', jurisdicao: 'ANVISA', esperaAchar: true },
  { tema: 'Cuidados pediátricos em ensaio clínico', jurisdicao: 'ANVISA', esperaAchar: true },
  { tema: 'Consentimento informado de população adulta', jurisdicao: 'ANVISA', esperaAchar: false },
  { tema: 'Assentimento para menores de idade', jurisdicao: 'FDA', esperaAchar: false }, // jurisdição errada
  { tema: 'Termo de Consentimento Livre e Esclarecido (TCLE)', jurisdicao: 'ANVISA', esperaAchar: false },
];

// parsearArgumentos é determinística e nova nesta variante, então também ganha teste.
const CASOS_TESTE_PARSE = [
  { nome: 'JSON válido', entrada: '{"tema":"x","jurisdicao":"ANVISA"}', esperaObjeto: true },
  { nome: 'objeto já parseado', entrada: { tema: 'x', jurisdicao: 'ANVISA' }, esperaObjeto: true },
  { nome: 'JSON truncado', entrada: '{"tema":"x","jurisdi', esperaObjeto: false },
  { nome: 'string vazia', entrada: '', esperaObjeto: false },
  { nome: 'JSON que não é objeto', entrada: '"só uma string"', esperaObjeto: false },
];

async function rodarTestesFerramenta() {
  console.log('== Testes: executarBuscaClausula (determinístico, 6 casos + 1 de parâmetro inválido) ==');
  let passou = 0;

  for (const caso of CASOS_TESTE_FERRAMENTA) {
    const resultado = await executarBuscaClausula({ tema: caso.tema, jurisdicao: caso.jurisdicao });
    const achou = resultado.texto !== null;
    const ok = achou === caso.esperaAchar;
    console.log(
      `  [${ok ? 'OK' : 'FALHOU'}] tema="${caso.tema}", jurisdicao=${caso.jurisdicao} -> ` +
        `achou=${achou} (esperado=${caso.esperaAchar})`
    );
    if (ok) passou++;
  }

  // Reproduz o bug real já corrigido: parâmetro grafado errado ("jurisdicicao") não pode
  // estourar exceção pro chamador, tem que virar aviso de falha própria da ferramenta.
  const casoInvalido = await executarBuscaClausula({ tema: 'x', jurisdicicao: 'ANVISA' });
  const invalidoOk = casoInvalido.texto === null && typeof casoInvalido.aviso === 'string';
  console.log(
    `  [${invalidoOk ? 'OK' : 'FALHOU'}] parâmetro mal formado ("jurisdicicao") tratado como ` +
      `falha própria da ferramenta -> ${invalidoOk}`
  );
  if (invalidoOk) passou++;

  const totalFerramenta = CASOS_TESTE_FERRAMENTA.length + 1;
  console.log(
    `Total: ${totalFerramenta} teste(s), ${passou} passou(passaram), ${totalFerramenta - passou} falhou(falharam).\n`
  );

  console.log('== Testes: parsearArgumentos (JSON vindo como string da OpenRouter) ==');
  let passouParse = 0;
  for (const caso of CASOS_TESTE_PARSE) {
    const resultado = parsearArgumentos(caso.entrada);
    const virouObjeto = resultado !== null;
    const ok = virouObjeto === caso.esperaObjeto;
    console.log(`  [${ok ? 'OK' : 'FALHOU'}] ${caso.nome} -> objeto=${virouObjeto} (esperado=${caso.esperaObjeto})`);
    if (ok) passouParse++;
  }
  const totalParse = CASOS_TESTE_PARSE.length;
  console.log(
    `Total: ${totalParse} teste(s), ${passouParse} passou(passaram), ${totalParse - passouParse} falhou(falharam).\n`
  );

  const passouTudo = passou + passouParse;
  const total = totalFerramenta + totalParse;
  if (passouTudo !== total) {
    throw new Error(`Testes determinísticos falharam: ${passouTudo}/${total} — corrija antes de rodar a simulação.`);
  }
}

// ---------- Retry com backoff (chamada ao modelo, não à ferramenta) ----------
// Distingue falha transitória (rede, timeout, rate limit — vale tentar de novo) de falha
// terminal (chave inválida, sem crédito, modelo inexistente — retry não resolve, é erro
// de configuração). Sem isso, qualquer soneca de rede escalava pro Approval Gate sem
// necessidade — e, pior, uma chave errada gastaria 3 tentativas pra dizer a mesma coisa.
//
// Diferença de formato nº 2: o Ollama expõe o código HTTP em `erro.status_code`; a SDK
// da OpenAI usa `erro.status`. Lemos os dois para o arquivo ficar honesto sobre a origem.
const STATUS_TRANSITORIOS = new Set([408, 409, 429, 500, 502, 503, 504]);
const STATUS_TERMINAIS = new Set([
  400, // requisição mal formada (schema da ferramenta, por exemplo)
  401, // chave inválida ou ausente
  402, // sem crédito na OpenRouter
  403,
  404, // modelo não existe / não disponível pra sua conta
  422,
]);

function ehErroTransitorio(erro) {
  const status = erro.status ?? erro.status_code;
  if (STATUS_TERMINAIS.has(status)) return false;
  if (STATUS_TRANSITORIOS.has(status)) return true;

  const codigo = erro.code || '';
  const mensagem = (erro.message || '').toLowerCase();
  return (
    codigo === 'ECONNREFUSED' ||
    codigo === 'ETIMEDOUT' ||
    codigo === 'ECONNRESET' ||
    mensagem.includes('timeout') ||
    mensagem.includes('fetch failed') ||
    mensagem.includes('econnrefused')
  );
}

async function chamarModeloComRetry(payload, tentativasMax = 3) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= tentativasMax; tentativa++) {
    try {
      return await cliente.chat.completions.create(payload);
    } catch (erro) {
      ultimoErro = erro;
      if (!ehErroTransitorio(erro) || tentativa === tentativasMax) {
        throw erro; // erro terminal, ou já esgotou as tentativas: sobe pro catch-all
      }
      const esperaMs = 500 * 2 ** (tentativa - 1); // 500ms, 1s, 2s...
      console.log(
        `[Retry] Falha transitória na chamada ao modelo (tentativa ${tentativa}/${tentativasMax}): ` +
          `${erro.message}. Tentando de novo em ${esperaMs}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, esperaMs));
    }
  }
  throw ultimoErro;
}

/**
 * Loop ReAct: Pensamento -> Ação -> Observação -> Resposta Final
 * Critério de parada explícito no orquestrador (Módulo 2.2), nunca deixado para o modelo.
 *
 * `maxIteracoes` tem default calibrado (4). O único lugar que o sobrescreve é o cenário
 * de demonstração do escalonamento em simularInteracao() — ver comentário lá.
 *
 * Retorna também `trilha`: um trace de DESENVOLVIMENTO (uma entrada por volta do loop,
 * com o que o modelo decidiu, quanto tempo levou e quantos tokens custou), pra você
 * inspecionar o raciocínio enquanto constrói. Isso não é observabilidade de produção —
 * a trilha de auditoria formal, em escala, com retenção e consulta, é tema do Módulo 5.2.
 *
 * Compare este corpo com o do react-agent-prototype.js (Ollama): fora a forma de ler a
 * resposta, é o mesmo código. O loop não sabe nem se importa com qual provedor respondeu.
 */
async function agenteICF(protocolo, { maxIteracoes = MAX_ITERACOES } = {}) {
  const historico = [
    {
      role: 'system',
      content:
        'Você redige seções de ICF para estudos clínicos. Sempre que precisar de uma cláusula ' +
        'regulatória, chame a ferramenta em vez de perguntar ao usuário ou de escrever de memória. ' +
        'Nunca peça esclarecimento ao usuário: decida os parâmetros da ferramenta a partir do ' +
        'protocolo fornecido.',
    },
    {
      role: 'user',
      content:
        `Protocolo do estudo: ${protocolo}\n\n` +
        'Jurisdição regulatória deste estudo: ANVISA.\n\n' +
        'Gere a seção de assentimento do ICF (Termo de Consentimento) para este estudo, se aplicável. ' +
        'Use a ferramenta disponível para buscar a cláusula regulatória correta antes de escrever o texto.',
    },
  ];

  const trilha = [];

  for (let volta = 1; volta <= maxIteracoes; volta++) {
    const inicioVolta = Date.now();

    // Pensamento: o modelo decide, com base no histórico acumulado, se já sabe o suficiente
    const resposta = await chamarModeloComRetry({
      model: MODELO,
      messages: historico,
      tools: [buscarClausulaRegulatoria],
    });

    // Diferença de formato nº 3: o Ollama devolve `resposta.message` direto; a OpenAI/
    // OpenRouter devolve uma lista de `choices`, e a mensagem está na primeira delas.
    const mensagem = resposta.choices[0].message;
    const chamada = mensagem.tool_calls?.[0];
    const duracaoMs = Date.now() - inicioVolta;
    // A OpenRouter reporta consumo em `usage` — sirva-se, é o preço desta volta do loop.
    const tokens = resposta.usage
      ? { entrada: resposta.usage.prompt_tokens, saida: resposta.usage.completion_tokens }
      : null;

    if (!chamada) {
      // Resposta Final: o modelo decidiu que já tem o que precisa
      trilha.push({ volta, acao: 'resposta_final', duracao_ms: duracaoMs, tokens });
      return { rascunho: mensagem.content, iteracoes: volta, trilha };
    }

    // Ação: executa a ferramenta fora do modelo (código determinístico)
    const argumentos = parsearArgumentos(chamada.function.arguments);
    const observacao = await executarBuscaClausula(argumentos);
    trilha.push({
      volta,
      acao: 'chamou_ferramenta',
      ferramenta: chamada.function.name,
      argumentos: argumentos ?? chamada.function.arguments, // se o parse falhou, mostre o texto cru
      observacao,
      duracao_ms: duracaoMs,
      tokens,
    });

    // Observação: volta como novo contexto para o próximo Pensamento.
    // Diferença de formato nº 4: a mensagem de resultado precisa de `tool_call_id`
    // casando com o id da chamada (o Ollama usava `tool_name`). Sem esse id a API
    // recusa a requisição da volta seguinte — o modelo não saberia a qual das
    // chamadas em paralelo aquele resultado responde.
    historico.push(mensagem, {
      role: 'tool',
      tool_call_id: chamada.id,
      content: JSON.stringify(observacao),
    });
  }

  // Limite de iterações atingido sem convergência: nunca falha silenciosamente
  return {
    rascunho: null,
    escalarParaAprovacaoHumana: true,
    motivo: `não convergiu em ${maxIteracoes} volta(s)`,
    trilha,
  };
}

function imprimirTrilha(trilha) {
  console.log('  [Trilha de desenvolvimento — não é a trilha de auditoria do Módulo 5.2]');
  for (const passo of trilha) {
    const custo = passo.tokens ? `, ${passo.tokens.entrada}+${passo.tokens.saida} tokens` : '';
    if (passo.acao === 'chamou_ferramenta') {
      console.log(
        `    volta ${passo.volta} (${passo.duracao_ms}ms${custo}): chamou ${passo.ferramenta}(` +
          `${JSON.stringify(passo.argumentos)}) -> ${JSON.stringify(passo.observacao)}`
      );
    } else {
      console.log(
        `    volta ${passo.volta} (${passo.duracao_ms}ms${custo}): decidiu que já tinha o suficiente, respondeu`
      );
    }
  }
}

/**
 * Simula três interações reais entre a Mariana (usuária) e o agente, cobrindo os três
 * comportamentos que a Missão Prática #02 pede que o aluno demonstre no próprio protótipo:
 * convergência normal, ferramenta sem resultado, e não-convergência com escalonamento.
 */
async function simularInteracao() {
  console.log(`(Modelo em uso via OpenRouter: ${MODELO})\n`);

  // ---------- Cenário 1: convergência normal, a cláusula existe ----------
  console.log('===== Cenário 1: convergência normal (cláusula encontrada) =====');
  const protocolo1 = 'Estudo fase II, público-alvo entre 12 e 17 anos, terapia oncológica experimental.';
  console.log('[Mariana submete o protocolo ao Gateway]');
  console.log('  ', protocolo1);
  console.log();

  const resultado1 = await agenteICF(protocolo1);
  console.log(`[Agente ICF] Rascunho gerado após ${resultado1.iteracoes} volta(s) de loop, via OpenRouter:`);
  console.log('  ', resultado1.rascunho);
  imprimirTrilha(resultado1.trilha);
  console.log('[Sistema] Rascunho aguardando revisão do Approval Gate antes de virar versão oficial.');
  console.log();

  // ---------- Cenário 2: ferramenta não encontra cláusula ----------
  console.log('===== Cenário 2: ferramenta não encontra cláusula (população adulta) =====');
  const protocolo2 =
    'Estudo fase III, população adulta (18-65 anos), diabetes tipo 2, sem envolvimento de menores de idade.';
  console.log('[Mariana submete o protocolo ao Gateway]');
  console.log('  ', protocolo2);
  console.log();

  const resultado2 = await agenteICF(protocolo2);
  imprimirTrilha(resultado2.trilha);
  if (resultado2.escalarParaAprovacaoHumana) {
    console.log('[Orquestrador] Loop não convergiu —', resultado2.motivo);
    console.log('[Sistema] Encaminhando ao Approval Gate para intervenção manual.');
  } else {
    console.log(`[Agente ICF] Respondeu após ${resultado2.iteracoes} volta(s), sem achar cláusula específica.`);
    console.log(
      '[Atenção] Repare na trilha: mesmo sem achar a cláusula, o modelo escreveu um rascunho genérico ' +
        'em vez de escalar — desviando da instrução do system prompt. É exatamente esse tipo de desvio ' +
        'que a trilha existe para flagrar, e por isso o Approval Gate revisa antes de qualquer coisa virar oficial.'
    );
  }
  console.log();

  // ---------- Cenário 3: não convergência, escalonamento ----------
  // maxIteracoes forçado a 1 só aqui: testamos e o modelo real, mesmo sem achar a cláusula,
  // tende a responder algo em vez de insistir por várias voltas (ver o desvio do Cenário 2)
  // — comportamento de LLM não é 100% previsível. Forçar o limiar garante que este cenário
  // sempre demonstre o mecanismo de escalonamento de forma confiável. Em produção, o
  // limiar calibrado continua sendo MAX_ITERACOES = 4, não 1.
  console.log('===== Cenário 3: não convergência, escalonamento (limiar forçado a 1 volta pra demo confiável) =====');
  const protocolo3 = 'Estudo fase III, população adulta, diabetes tipo 2, sem envolvimento de menores de idade.';
  console.log('[Mariana submete o protocolo ao Gateway]');
  console.log('  ', protocolo3);
  console.log();

  const resultado3 = await agenteICF(protocolo3, { maxIteracoes: 1 });
  imprimirTrilha(resultado3.trilha);
  if (resultado3.escalarParaAprovacaoHumana) {
    console.log('[Orquestrador] Loop não convergiu —', resultado3.motivo);
    console.log('[Sistema] Encaminhando ao Approval Gate para intervenção manual — nunca falha silenciosamente.');
  } else {
    console.log('[Atenção] O modelo convergiu na única volta permitida antes mesmo de precisar escalar.');
  }
}

async function main() {
  await rodarTestesFerramenta();
  await simularInteracao();
}

if (require.main === module) {
  main().catch((erro) => {
    console.error('[Erro não tratado]', erro.message);
    console.log('[Sistema] Encaminhando ao Approval Gate — falha técnica também é motivo de escalonamento.');
  });
}

module.exports = { agenteICF, executarBuscaClausula, parsearArgumentos, rodarTestesFerramenta };

/*
 * Ahirton Lopes · AI Architecture Toolkit — UNIPDS: Arquitetura de Sistemas com IA
 * Prof. Ahirton Lopes, Ph.D. — GDE AI, Microsoft MVP, Senior Manager
 */
