# Acervo compartilhado da instalação própria

Data: 2026-10-29. Serviço preparado na VPS existente; nenhuma inferência ou rotina recorrente nova ativada neste marco.

O serviço `robson-assistant-cognee-owner.service` usa o Cognee 1.6.5 já instalado, com raiz persistente própria `knowledge-owner-v1` e namespace fixo `personal-shadow-20261026 / knowledge-v1`. Esse será o mesmo acervo para MCP, Telegram, WhatsApp e curadoria. A geração operacional permanece separada da identidade do acervo.

O acervo sintético dos ensaios anteriores foi preservado. O serviço novo escuta somente em loopback, porta 8982, sob o mesmo usuário sem login e hardening do serviço de prova. Não recebe chave de modelo; as decisões de aprendizado vêm do agente autorizado no Own.

O túnel existente ganhou uma segunda regra, preservando a regra de prova e o catch-all404. `assistente-conhecimento.robsonlins.com` aponta ao novo serviço por HTTPS; a API exige credencial privada e não expõe SQL ou escolha livre de namespace. A credencial foi criada fora do Git, com permissão600. Não foi copiada nenhuma chave OpenAI nem dado do Elo.

Leitura externa autenticada de `/health`: **200**, `ready:true` e namespace esperado. Sem autenticação: **401**. Recibo privado `knowledge-owner-channel-proof.json`, observado em `2026-10-29T06:37:25.735Z`. Isso comprova o canal e a separação do acervo; não comprova julgamento do modelo ou criação do grafo pelo MCP.

Naquele ponto, Own e Source de produção ainda usavam seus deployments anteriores. O novo código permanece desligado por padrão. A aceitação final exige criação de relações pelo MCP existente, consulta por outra sessão nativa e correção/retirada refletida no bot, além das provas de envio aprovado.

Não houve contratação de infraestrutura. O serviço usa capacidade da VPS e da conta já existentes; custos compartilhados e faturas continuam separados dos recibos de inferência. A curadoria diária fica desligada até a estimativa de operação ser apresentada.
