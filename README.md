# WhatsApp MCP pessoal

MCP para localizar conversas individuais e grupos, arquivar mensagens com autoria, consultar recortes e arquivos privados, transcrever áudio selecionado, enviar texto/imagem/PDF/áudio e administrar grupos com confirmação humana.

**Versão 0.5.0:** captura automática de novas conversas individuais e grupos, com exceções persistentes. Publicação e ativação dos 1.424 legados autorizadas pelo dono em 20/10/2026; evidências operacionais em [captura opt-out](docs/33-captura-opt-out.md).

[Configure sua instância na página privada](https://whatsapp.robsonlins.com/setup). O botão **Conectar no GPT** abre o plugin privado Zap com login e consentimento. Credenciais nunca vão ao chat; Elo permanece separado.

[Fluxo de configuração e segurança](docs/26-setup.md). Você pode desativar a captura de qualquer conversa pelo Zap. Reativar não recupera mensagens do período desligado nem importa histórico retroativo.

## Rodar e conferir

Node 22+:

```sh
npx --yes npm@11 ci
npm run check
npm test
npm run build
npm run db:local
npm run dev -- --local --port 8787
```

Smoke local: `node scripts/smoke.mjs http://localhost:8787`. O padrão é manutenção ativa, zero chats liberados, mídia privada e transcrição desabilitada. `build` é apenas empacotamento/dry-run.

## Uso e documentação

- [Instalação, ativação e uso diário](docs/18-instalacao.md).
- [PRD e critérios de aceitação](PRD.md), [plano](docs/09-plano-de-implementacao.md) e [evidências da entrega inicial](docs/10-entrega.md) e [entrega de grupos](docs/25-entrega-grupos.md).
- [Autenticação e confirmação](docs/13-auth.md), [transporte](docs/14-zapi.md), [mídia/áudio](docs/15-media.md), [ações](docs/16-acoes.md) e [operação](docs/17-operacao.md).
- [Issues](https://github.com/orobsonn/whatsapp-mcp/issues), [changelog](CHANGELOG.md) e [releases](https://github.com/orobsonn/whatsapp-mcp/releases).

## Confirmações

Envios e ações comuns são autorizados no chat, sem abrir página. O pedido exato do dono já pode autorizar; alvos ou conteúdo ambíguos precisam de esclarecimento. A página fica para ações críticas, com nomes e consequências legíveis. A decisão de risco é do servidor, não do modelo. [Política e limites](docs/31-confirmacoes-simples.md).

## Limites explícitos

Arquivo desde ativação, sem promessa de importação retroativa. Arquivos até 2 MiB; até 128 KiB no conteúdo MCP, maiores via navegador autenticado. Áudio sob demanda, com opt-in do processador. Envios incertos não repetem automaticamente. Estado de grupo é agregado. Nomes/conteúdo necessários podem aparecer na IA; tokens e URLs de transporte ficam no backend. Excluir aqui não apaga cópias de terceiros.

Gestão de grupos na v0.2.0: [escopo e critérios](docs/20-grupos-prd.md), [contratos oficiais mapeados](docs/21-grupos-contratos.md), [manual de uso](docs/23-usar-grupos.md) e [matriz das 35 operações](docs/24-grupos-cobertura.md). Inclui participantes/admins, convites, permissões, menções, organização dos chats e associações com comunidades. OCR, campanhas e busca semântica continuam fora do escopo. Nenhuma ferramenta genérica de API/SQL é exposta.

## Histórico do projeto

A pasta começou como handoff documental em 18/10; esse material permanece como registro histórico, não estado atual: [BRIEF](BRIEF.md), [CONTEXT](CONTEXT.md), [escopo](docs/01-escopo-e-jornadas.md), [privacidade](docs/02-privacidade-e-dados.md), [pesquisa Z-API](docs/03-integracao-zapi.md), [engenharia candidata](docs/04-engenharia-a-validar.md), [plano original](docs/05-plano-inicial-e-testes.md), [mapa do Elo](docs/06-mapa-do-elo.md), [crítica inicial](docs/07-revisao-adversarial.md) e [retomada original](docs/08-proxima-sessao.md). Referências fixam hashes/commits; nenhum código, dado ou credencial do Elo foi copiado.
