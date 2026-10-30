# GitHub: autorização antes da contagem de I/O

Em 30/10/2026, a avaliação real passou a tentar consultar o GitHub, mas a resolução terminou em `github_dialogue_expired`. A credencial existente não foi identificada como inválida: verificações de atualidade da conversa consumiam o prazo antes de a chamada HTTP começar.

O preflight de autorização agora termina antes de iniciar o timer de leitura HTTP. Todas as cinco leituras do conector GitHub e o manifesto do diálogo legado usam esse caminho. Cancelamento, prazo absoluto e autorização continuam verificados antes de cada solicitação; os controles após leitura e antes de exposição permanecem. As três operações GitHub do agente têm prazo total de 120 segundos; cada leitura HTTP mantém seu próprio limite. Calendar preserva seu prazo anterior.

Validação sintética: reprodução anterior com falhas; após a correção, quatro arquivos e 65 testes passaram, além de TypeScript e build da assistente. Cobertura inclui prova lenta, HTTP travado, cancelamento durante prova, prazo absoluto e retirada de acesso. Revisão adversarial do diff sem problemas críticos ou importantes.

Isso comprova o reparo local, sem afirmar que a pergunta real já foi respondida. O dono informou que outra sessão trata a decisão de produto da receita e pediu somente validar a capacidade do agente, sem responder agora. A homologação real da consulta após publicação continua separada desta evidência.
