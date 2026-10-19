# WhatsApp MCP pessoal

Data: 19/10/2026. Pedido de implementação: Robson nesta sessão. As decisões de engenharia abaixo são responsabilidade do implementador, não validação técnica do dono.

## Resultado

Gerenciar pelo chat conversas individuais e grupos: localizar destinos, consultar mensagens com autoria e cobertura, encontrar e abrir imagem/PDF, transcrever áudio selecionado, enviar texto e arquivos com confirmação concreta e acompanhar o resultado. Guardar o que foi efetivamente capturado, incluindo mensagens próprias, sem prometer histórico anterior ou entrega de todos os membros de um grupo.

## Escopo desta entrega

1. Serviço próprio TypeScript/Cloudflare Workers, D1 para arquivo e R2 privado para bytes; migrations, configuração reproduzível, CI e fixtures exclusivamente sintéticas.
2. Adaptador Z-API de contrato fechado. Agenda e grupos paginados; webhook autenticado independente do login; identificação exata de conversa e participante; tipos texto/imagem/PDF/áudio/indisponível; mensagens próprias, deduplicação, status monotônico, edição e tombstones.
3. Consulta por conversa, período, autoria, tipo e termo; páginas e limites de saída; identificação de lacunas. Consultar arquivo não marca lido no WhatsApp.
4. Mídia privada com referência interna, limite de bytes, validação de conteúdo e hash imutável. Download somente de hosts específicos configurados e confiáveis, sem redirects ou credenciais de API. Upload autenticado pelo dono; nenhum endpoint de URL arbitrária no MCP. Exclusão invalida acesso aos bytes e derivados.
5. Texto, imagem, PDF e áudio para indivíduo/grupo: preparar envelope imutável com destino, conteúdo, hash e opções; confirmação humana em página autenticada separada do MCP; execução única por claim atômico; expiração/cancelamento; timeout fica incerto, sem retry automático. Resposta aceita é distinta de enviado/entregue/lido.
6. Transcrição sob demanda via binding Workers AI, desabilitada até configuração explícita do processador. Original e derivado separados; limite de tamanho/duração, claim e fence contra exclusão/edição. Sem OCR ou transcrição em massa.
7. MCP remoto via SDK oficial, Streamable HTTP, OAuth com PKCE e login do dono via Cloudflare Access/JWT validado por issuer/audience/subject. Access não protege o callback Z-API. Leitura, upload, confirmação e objeto exigem autorização atual. Tokens, callback e payload bruto não entram em logs/respostas MCP.
8. Diagnóstico sanitizado; modo manutenção que bloqueia novas ações; retenção configurável e desabilitada até escolha explícita, captura apenas dos chats liberados; exportação por conversa e exclusão local abrangendo derivados. Rotação/restore invalida ações antigas pelo epoch configurado fora do banco restaurado. Manual de instalação, operação e matriz de homologação real.

9. Ampliação autorizada em 19/10: administração completa das 22 operações documentadas de Groups, 9 de Chats aplicáveis e 4 de Communities para associações. Criação/entrada, participantes/admins, permissões, convites, menções e organização do chat seguem proposta → confirmação humana → tentativa única. Inventário, restrições e revisão adversarial: [PRD de grupos](docs/20-grupos-prd.md).

## Padrões reversíveis escolhidos pela engenharia

- Instalação de um dono, sem SaaS/multi-tenancy, motor genérico de provedores, embeddings, agendador de campanhas ou memória automática.
- Nenhuma conversa é capturada até liberada pelo dono. Cadastro de destino/diretório não libera captura implicitamente. Temporárias/visualização única são registradas apenas como indisponíveis.
- Arquivo não expira automaticamente antes de uma política explícita. Dados de ensaio são sintéticos. Ativação real requer nova instância/credenciais, lista de chats e política escolhidas pelo dono.
- Nomes e conteúdo necessários podem aparecer nos resultados; endereços externos, URLs de mídia e segredos permanecem no backend. Saída sempre tratada como conteúdo não confiável, nunca autorização.
- OCR, importação retroativa, canais, ligações e apagar mensagens para todos continuam fora deste marco. Administração de grupos e organização de chats passam ao escopo da v0.2.0 por pedido posterior do dono. Não se amplia automaticamente para toda a administração de comunidades.

## Critérios de aceitação

- Um cliente MCP de teste inicializa, lista schemas tipados e executa a jornada sintética grupo → ingestão → consulta/autoria → mídia → proposta → confirmação autenticada → execução → status → consulta própria.
- Dois grupos homônimos, participante comum e IDs repetidos em chats distintos nunca misturam conteúdo. LID não vira telefone.
- Replay/concorrência não duplicam captura ou tentativa; exclusão não ressuscita conteúdo; status anterior ao corpo é conciliado; edição invalida derivados/trabalho antigo.
- Download/upload/export/transcrição não atravessam autorização, limite de tamanho ou versão; nome/MIME enganoso, redirect, host proibido e conteúdo hostil são recusados ou expostos como dados.
- Sem login, com token de outro dono/issuer/audience, ação alterada/expirada/cancelada, manutenção ou geração antiga: efeito recusado. MCP não aprova sua própria proposta.
- CI, typecheck, testes relevantes no runtime real local e build passam no HEAD entregue. Cada issue registra evidência e revisão; sem inventar ensaio com provedor ou cliente externo.
- Código completo e instalação preparada são distintos de ativação real: pareamento, credenciais, novo processador e envios de ensaio reais dependem da configuração/autorização específica do dono. Essas pendências ficam abertas até resultado observado.

## Contratos fechados após revisão adversarial

- Aprovar envio, ampliar captura, alterar política persistente e excluir arquivo: GET apenas apresenta; POST exige JWT Access do dono, origem exata e nonce curto de uso único vinculado a subject, epoch e envelope. Bearer MCP não autoriza confirmação. HTML externo sempre escapado; CSP e frame-ancestors restritos.
- Epoch externo da instalação cobre tokens/grants MCP, confirmação, ações e trabalhos; geração externa da conexão cobre destino/aparelho e callbacks. Restore requer rotação do epoch antes de liberar acesso. Access logout isolado não promete revogação imediata MCP; tokens têm validade limitada e epoch atual é revalidado em toda ferramenta/objeto.
- D1 é autoridade de visibilidade. Mídia usa chave imutável, claim durável e publicação condicional por versão/epoch/geração/tombstone após gravar R2. Fence perdido remove resultado; exclusão bloqueia leitura antes de remover bytes/derivados. Sem transação aberta durante rede/IA. Bytes já transmitidos não são recuperáveis.
- Webhook dá sucesso somente após persistir mensagem e trabalho de mídia de chat liberado. Cron retoma tabela D1 com lease/retry limitado; waitUntil sozinho não é durabilidade. Atrasos/falhas aparecem na cobertura.
- Envio de mídia usa Base64 limitado do objeto privado imutável (2 MiB máximo); não há bucket público/capacidade pública. Abrir mídia autenticada pelo navegador e obter conteúdo no MCP são caminhos distintos: MCP devolve conteúdo pequeno em bloco suportado, maior via navegador do dono com limitação explícita.
- Namespace de captura: geração + conversa externa exata + ID externo. Identificadores de retorno Z-API permanecem distintos. Status sem conversa e com correlação ambígua fica pendente, nunca altera o primeiro registro encontrado. Entrega/progressão e falha/incerteza são campos separados.
- Limites iniciais: evento JSON 256 KiB, arquivo 2 MiB, texto 8 mil caracteres, página 50 mensagens/32 mil caracteres, diretório 100 itens por página, até 5 trabalhos de mídia por tick, lease 120s, 3 tentativas com backoff. Áudio somente formatos suportados; duração declarada acima de 120s é recusada e não é tratada como medição confiável. Limite de bytes e deadline protegem o processador; não se promete aferir duração real sem decoder. Valores operacionais conservadores, não capacidade comercial.
- Escopo de conclusão confirmado pelo dono: continuar sem instância Z-API; entregar software verificado e manual, mantendo ativação/homologação real pendentes.

## Entrega por issues

1. Fundação e arquivo: schema, ingestão, diretório, consulta/cobertura, isolamento e testes D1.
2. Transporte e ações: Z-API tipada, sincronização e envio recuperável com claim/envelope.
3. Mídia e áudio: upload/download privado, bytes imutáveis, transcrição e derivados.
4. Acesso e confirmação: OAuth MCP, login do dono e aprovação humana vinculada.
5. Experiência MCP: catálogo fechado, integração das jornadas e teste de cliente completo.
6. Operação e entrega: retenção, exclusão/export, recuperação, CI, documentação, release e homologação.
7. Ampliação de grupos: issues #8–10, contratos oficiais completos, serviço recuperável, catálogo MCP e confirmação, revisão/CI/release 0.2.0.

## Política de execução

Aplicar a lógica do claude-harness sem instalá-lo: FULL por segurança e dados externos; plano por issue; TDD em comportamento que pode perder dados, misturar conversas, vazar dados, duplicar efeitos ou quebrar contratos; sem testes artificiais para documentação/configuração trivial. Commit por fatia; revisão independente e correção dos achados. Rotas disponíveis nesta sessão: mecânico gpt-6-luna/low, implementação delimitada gpt-6-sol/medium, contratos/segurança gpt-6.1-sol/high, adversarial final gpt-6-astra/high. Escalar quando houver falha ou incerteza material, sem alegar modelos antigos indisponíveis.

## Fontes e limites

Todo o handoff da raiz, docs e referencias foi lido. Conhecimento do Elo serve como referência; nenhuma configuração, dado ou código foi copiado. Harness remoto consultado em main 7634e3284dbe402f9229b18a13c658ace3afe3fd, release v3.10.0; cópia local estava em outro commit e não é a autoridade desta entrega. Docs oficiais Z-API e Cloudflare serão revalidadas no módulo correspondente. RTK.md e ~/.Codex/rules/releases.md não foram encontrados nos caminhos indicados; não se inventa seu conteúdo.
