# WhatsApp MCP pessoal

Ponto de partida do MCP próprio de Robson para gerenciar seu WhatsApp pela IA: conversas individuais e grupos, áudio, texto, imagens, PDF e arquivo de mensagens recebidas e enviadas.

**Estado em 18/10/2026:** briefing, pesquisa e transferência de aprendizados. Sem aplicação, dependências instaladas, conexão, deploy ou dados do WhatsApp nesta pasta. O Elo continua separado, disponível para demonstração. A instância Z-API existente não foi alterada nem migrada.

## Começar por aqui

1. [Brief e decisões do dono](BRIEF.md).
2. [Escopo e histórias de uso](docs/01-escopo-e-jornadas.md).
3. [Privacidade sem inviabilizar as funções](docs/02-privacidade-e-dados.md).
4. [O que a documentação Z-API permite afirmar](docs/03-integracao-zapi.md).
5. [Aprendizados reais do Elo](CONTEXT.md) e [mapa para consultar seu código/testes](docs/06-mapa-do-elo.md).
6. [Engenharia candidata, ainda a validar](docs/04-engenharia-a-validar.md).
7. [Sequência sugerida e testes](docs/05-plano-inicial-e-testes.md).
8. [Revisão crítica](docs/07-revisao-adversarial.md) e [entrada para a próxima sessão](docs/08-proxima-sessao.md).

## Orientação principal

Privacidade é preferência importante, mas Robson aceita flexibilizar a exposição de conteúdo quando esconder dados inviabilizar a função. Não transformar essa preferência em anonimização universal nem em envio automático de toda a base à IA. Credenciais permanecem protegidas. Buscar/organizar no backend pode reduzir a exposição; para compreender uma mensagem, voz ou documento, algum processador precisa acessar o conteúdo relevante.

Este projeto não herda o limite de texto individual, a retenção de 30 dias, o domínio de consultoria ou a extração DeepSeek automática do Elo. Grupos e mídia fazem parte do objetivo daqui. A stack, o provedor operacional, a retenção, o processamento de áudio e a política de ações ainda precisam ser fechados antes de implementar.

Os [manifestos de referência](referencias/) fixam versões, hashes e evidências consultadas. Não são um backup do Elo nem autorização para usar suas credenciais.
