# Evidência de entrega

## Autorização e fronteira

19/10/2026: Robson pediu criação pública no GitHub, PRD/issues e implementação contínua com TDD proporcional e lógica do claude-harness sem instalação. Confirmou que não há instância separada e autorizou continuar sem ela. Nenhum teste real com WhatsApp, pareamento ou alteração do Elo é parte da prova deste ciclo.

## Registro

- Repositório: https://github.com/orobsonn/whatsapp-mcp (público).
- Baseline documental: c3ed094.
- Harness consultado via GitHub: main 7634e3284dbe402f9229b18a13c658ace3afe3fd, release v3.10.0. Contratos de triagem/delivery/governança e roteamento lidos; nenhum arquivo de runtime instalado.
- Dependências escolhidas por metadados npm atuais; implementação nova, sem código ou dados copiados do Elo.

## Pendências de ativação real

Instância Z-API própria, recursos/segredos próprios, identidade Access do dono, seleção de chats, retenção e opt-in do processador de áudio. Depois: ensaio individual/grupo por origem telefone/Web/API, imagem/PDF/áudio, login e ferramenta no cliente final. Até lá, são capacidades implementadas e testes controlados, não produção homologada.

## Resultado do marco v0.1.0

Implementação em seis issues do [milestone](https://github.com/orobsonn/whatsapp-mcp/milestone/1). Commit final de correção funcional: `40ce77f`; commits posteriores fecham documentação/metadados/release. Toda evidência abaixo é local/sintética.

| Issue | Entrega | Prova relevante |
|---|---|---|
| #1 | Arquivo/diretório, identidade, captura e cobertura | 15 testes archive; D1 real no workerd; quatro achados da revisão corrigidos |
| #2 | Z-API fechada e ações imutáveis | 9 testes transporte + 15 ações; claim único, timeout, status concorrente/precoce, ambiguidade e arquivo de saída |
| #3 | Mídia privada e áudio sob demanda | 30 testes R2/workerd, formatos, limites, lease/retry, fences, exclusão em voo e transcrição sintética |
| #4 | Owner Access + OAuth + confirmação humana | 14 testes; JWT assinado sintético, PKCE/token/refresh/epoch, CSRF, nonce, scopes e corpo bounded |
| #5 | Ferramentas e jornada real de protocolo | 2 testes de integração com SDK HTTP: OAuth, sincronização, política humana, webhook, consulta, aprovação, envio/status, upload/download e PDF no MCP |
| #6 | Operação/retomada/entrega | 6 testes retenção/exclusão/exportação/diagnóstico/limpeza; CI, manual e smoke local |

Validação final em 19/10/2026:

- `npm run check`: exit 0.
- `npm test`: **7 arquivos, 91 testes, 0 falhas**, exit 0. Logs locais `/tmp/whatsapp-mcp-delivery-tests.log`; warnings de dependências (punycode/sourcemaps) não mascaram falhas.
- `npm run build`: exit 0, dry-run do Worker completo; não é deploy. `/tmp/whatsapp-mcp-delivery-build.log`.
- `npm audit --omit=dev`: exit 0, zero vulnerabilidades reportadas. `/tmp/whatsapp-mcp-delivery-audit.json`.
- `npm run db:local`: quatro migrations aplicadas no D1 local, exit 0; sem migração remota.
- `node scripts/smoke.mjs http://localhost:8787`: exit 0; versão `0.1.0`, manutenção true, arquivo privado recusado com 403. Serviço de desenvolvimento local; nenhum WhatsApp conectado.
- Revisão adversarial final gpt-6-astra/high: três P2 corrigidos, um diagnóstico corrigido e sugestões de limpeza/retencão incorporadas. Complementação sem conversa exigiu nova regressão e revisão. Veredito final: sem bloqueadores remanescentes no escopo inspecionado (`docs/19-auditoria-final.md`).

## Roteamento e processo realmente usados

Fundação/auth/mídia e revisão de desenho: gpt-6.1-sol/high. Transporte Z-API e operação delimitada: gpt-6-sol/medium. Revisão final: gpt-6-astra/high. Coordenação, integração e correções de ações nesta sessão principal. O harness foi consultado por API GitHub; não instalado. RED/GREEN em riscos de dados/efeitos/contratos, sem testes artificiais de texto/configuração.

CI remoto e fechamento das seis issues devem apontar ao HEAD final da PR; esses resultados permanecem verificáveis no GitHub, sem introduzir conteúdo privado como prova. A release por marco sincroniza package.json, lockfile, CHANGELOG e tag v0.1.0. O milestone é software validado localmente; não é ativação da conta.

## Integração GitHub

[PR #7](https://github.com/orobsonn/whatsapp-mcp/pull/7) merged em 19/10/2026, commit `ae91f41257cea5603dd0ae3e3a1d692b3bcddd73`. As seis issues foram fechadas automaticamente pelo merge. CI do HEAD `3f241b6` aprovado em ambos os gatilhos: [push](https://github.com/orobsonn/whatsapp-mcp/actions/runs/39259994952) e [PR](https://github.com/orobsonn/whatsapp-mcp/actions/runs/39260037442). O [histórico CI da main](https://github.com/orobsonn/whatsapp-mcp/actions/workflows/ci.yml?query=branch%3Amain) registra a verificação da árvore integrada. A [release v0.1.0](https://github.com/orobsonn/whatsapp-mcp/releases/tag/v0.1.0) identifica o marco de software, sem ativação real.
