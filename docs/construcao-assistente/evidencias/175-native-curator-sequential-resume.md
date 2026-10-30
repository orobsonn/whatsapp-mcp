# Compactação e retomada administrativa sequencial

Data:30/10/2026. Continuação do diagnóstico174. A diária4c5d e suas duas tentativas anteriores permanecem preservadas; não houve conclusão contábil antecipada nem pagamento reclassificado.

## Mudança e revisão

Removidos overrides de compactação2048/1024 do perfil. Flue usa seus padrões por modelo; por pedido explícito do dono em30/10, o host amplia o limite de saída8192→16384tokens por chamada, preservando o teto históricoUS10 e todas as reservas. Isso remove uma restrição sem fundamento, não confirma a causa HTTP da falha anterior. Falhas SSE passam a registrar somente responseState e incompleteReason de enums fechados, além do estágio/status já existentes. Prosa, corpo e credenciais não entram nesses diagnósticos.

A retomada seleciona o recibo predecessor exato, deriva apenas sua próxima revisão e confere MAX(predecessor) antes da criação ou MAX(next) durante replay. Config antiga com revisão posterior é recusada. Uma seleção constante não cria terceira/quarta tentativa automaticamente. Identidade, grant, corpo, hash, settlementSDKfailed/aborted e UID seguem obrigatórios. Não há migração, infraestrutura ou ferramenta nova.

Revisão adversarial explícita encontrou o risco de usar MAX puro na seleção: o próprio next faria o replay falhar. A implementação usa predecessor exato e máximo condicional. Revisão final do diff sem Critical/Important. Recomendação: medir retomada real, incluir TODAS as linhas financeiras da sessão e conservar incertos.

## Verificação antes da publicação

Três RED reproduziram seleção3 ausente, concorrência3 ausente e override ainda declarado. Host/runtime passaram92/92 casos; o diagnóstico final foi refeito com canary privada sem inserir a própria chave sintética no SSE (que corretamente ativa o bloqueio de segredo antes do parse). Caso dirigido corrigido passou; adaptador completo28/28, tipos e buildOwn passaram. A prova CF de erro incerto/overflow/headroom174 permanece distinta da nova medição real. Não se repetiu suíte local pesada nem simulador sem mudança pertinente.

## Operação real

Own8114971e publicou o código81bde28, saída16384 e seleção explícita da revisão3. SDKsub_ik_197b37564add24ef178d9322aed34830 iniciou10:54:33UTC e terminoufailed11:20:57UTC. Não houve mudança de sessão, janela diária ou UID. A compactação nativa persistiu10:56:31UTC, resumo4451caracteres,269716tokens antes. Seus dois recibos completos somam10045microUSD. O contexto seguinte caiu para4339tokens.

A execução inteira acrescentou11 recibos, todoscomplete,137696microUSD (US$0,137696); a consulta inclui chamadas de compactação fora das mensagens canônicas. Não acrescentou recibo incerto. A última chamada91614in/720out custou23444microUSD e teve HTTP200. Após contabilizá-la, a revalidação das fontes retornou reader_timeout após5065ms; SDK recebeu a recusa estática native_model_uncertain. Isso não transforma o recibo financeiro completo em incerto nem comprova resposta utilizável. O diagnóstico distingue essa falha da compactação anterior.

Cobertura final observada:73evaluated,1learned,48presented,125unavailable,355skipped_policy,7superseded e213withdrawn. O MCP leu independentemente a nova relação com duas evidências WhatsApp, classificaçãoreported; não se publicam nomes, textos nem fontes reais. A diária permanecepending e as48apresentadas não contam como avaliadas. Não houve resumo de sucesso nem conclusão forçada.

A configuração temporária foi removida na publicação5949b01b com bindings, runtime, horários e modoapproval preservados. Autonomia permanece desligada. CI41043349724 do código81bde28 concluiu com sucesso. Censo11:25UTC:US$2,344002 comprometidos nos ledgers conhecidos, incluindoUS$0,381277 incertos, contraUS$10; não é fatura do fornecedor.
