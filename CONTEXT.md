# Conhecimento portado do Elo

Inspeção em 18/10/2026. Fonte: repositório local `../elo`, commit `ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7`. O runtime da integração da agenda identificado nas evidências é `f9285065271617ece67739ea95022d3b641cf0f8`. São commits diferentes porque a documentação evoluiu depois do deploy.

Os [manifestos](referencias/elo-snapshot.json) fixam arquivos/hashes/permalinks. Nenhum banco, mídia, conversa real, sessão ou credencial foi portado. Este resumo substitui leituras antigas de memória que diziam que o Elo ainda não tinha implementação: essa descrição histórica já estava desatualizada.

## Provas reais que já existiam no Elo

| Resultado | Evidência e fronteira |
|---|---|
| Login do dono integrado ao OAuth MCP | `docs/implementacao/auth.md` e evidências de homologação. Access autentica identidade; a biblioteca emite os tokens MCP. Não é só cookie ou gate de HTML. |
| Recepção e resposta individual de texto | Ensaios publicados e homologação; existe demonstração posterior de uma ação aprovada e `delivered` relido. Não estender isso a grupo, áudio ou PDF. |
| Mapeamento da agenda sem mensagens | Dez páginas Z-API, 936 registros, 935 contatos mapeados; busca por nome, preparo e cancelamento. `agenda-whatsapp-prova-1810.json`. |
| Cliente ChatGPT usando nova Skill | Atualizar ferramentas da conexão existente e abrir conversa nova permitiu `contacts_sync` até o fim. Atualizar só o pacote não atualizou o catálogo da conversa antiga. |
| Envios aprovados e cancelamento | Caso de cancelamento com estado `cancelled` e sem envio ao provedor; outro caso de envio humano aprovado, uma execução e consulta `delivered`. `docs/demonstracoes/evidencias/verificacao-1810.json`. |
| Núcleo de testes | Relatório da agenda: 189 testes Worker/D1 e 22 Node, check/build e seis smokes. São evidências daquela entrega, não testes executados no novo projeto. |

## Captura e histórico: o que funcionou

O webhook valida segredo próprio e instância antes de processar; login humano não fica na frente do callback. O segredo na URL é uma capacidade, não uma assinatura criptográfica do corpo. `Client-Token` autentica a chamada ao fornecedor e não prova a origem de um callback recebido.

Persistir primeiro e processar depois. No Elo, receber não espera DeepSeek. Há direção `fromMe`, data original e de recebimento, tipo, ID interno, chave de dedup e estado. Eventos repetidos, estados fora de ordem e status anterior ao corpo são casos previstos. Edição cria versão nova; exclusão deixa tombstone para não ressuscitar conteúdo por replay. Escritas usam transações e fences de versão/geração.

A chave do Elo usa geração da conexão + ID da mensagem. Ela precisa ser reavaliada para grupo, participante, outros formatos e origens antes de virar chave do MCP novo. Não basta remover o `if (isGroup)` do parser: as identidades, projeções e ações seguintes continuam desenhadas para contato individual.

### O incidente das onze fontes

Uma fonte já tinha expirado e dez não tinham texto suportado pelo parser. Os registros dessas dez não guardavam subtipo suficiente para saber se eram áudio, imagem, reação ou outra coisa. Não eram onze textos recuperáveis. A correção permitiu preencher fonte ainda vazia quando um callback posterior trouxesse texto válido, com revalidação transacional.

Aprendizado para o novo MCP: guardar tipo e metadados normalizados necessários para explicar lacuna; distinguir mídia não baixada, expiração, falha, formato desconhecido e mensagem aguardando conteúdo. Preservar referência segura à mídia quando autorizada. Não guardar payload integral por conveniência nem alegar perda zero. Ausência de texto não significa necessariamente áudio.

## Identidades e agenda

Guardar o endereço exato do fornecedor no backend e devolver ID interno evita que o modelo monte números. `contacts_list` pesquisa alias e índice de nomes restrito; nome parecido não une pessoas. Sincronização paginada não deve concluir ausência/unicidade antes do fim. O percurso externo não tem snapshot imutável comprovado; não apagar tudo que faltou numa página.

O Elo confere o aparelho antes/depois da leitura da agenda e usa geração da conexão/dados no cursor e na transação. O MCP novo precisa do equivalente para não aplicar uma resposta obtida de uma instância antiga à atual. LID não é um telefone codificado e não deve ser convertido numericamente.

Bloqueio de recadastro após exclusão usa HMAC do endereço. Funciona para exclusões cobertas pela migração; não recebeu garantia retroativa. Rotação da chave altera o domínio desses fingerprints: não trocar chave isoladamente. Isso é referência de desenho, não requisito já escolhido para toda operação do novo MCP.

## Envios

A ação do Elo congela alvo e texto e retorna proposta com hash e validade de dez minutos. Uma resposta humana posterior aprova a proposta; a execução faz claim condicional atômico para uma única tentativa. Antes de enviar, revalida conexão, identidade do aparelho e vínculo do contato. A Skill não é prova criptográfica de que o humano clicou; o servidor valida vínculo, validade e consumo.

Se o provedor aceitou mas a resposta se perdeu, o resultado fica incerto; não reenviar uma cópia. Status pode chegar antes de o retorno da API ser gravado. Conciliar a mesma ação. Esse padrão é útil, mas o hash do Elo cobre o texto e o vínculo é validado à parte: para mídia/grupo, decidir um envelope canônico que inclua destino, arquivo/hash, legenda, resposta/citação e opções relevantes. Não anunciar exatamente-uma-entrega em rede externa.

## Autenticação e compatibilidade: erros que os mocks não pegaram

- `redirect: "error"` não funcionou no runtime workerd; a correção usa `manual` e recusa 3xx sem levar segredo ao destino do redirect.
- Access OTP pode omitir `email_verified`. No Elo a aceitação depende do issuer correto e do IdP OTP exclusivo provisionado; não generalizar para qualquer provedor.
- `Referrer-Policy: no-referrer` gerou `Origin: null` no POST real de consentimento. A correção preserva origem sem vazar query. Não resolver aceitando `null` ou removendo CSRF.
- CSP `form-action` afeta redirects; permitir apenas a origem validada do callback, sem wildcard.
- Refresh concorrente precisa evitar sobrescrever token rotacionado. Prazo absoluto não pode avançar a cada renovação.
- Revogar Access não provou revogação instantânea de todos os tokens MCP. Epoch externo, dono desabilitado e manutenção bloqueiam chamadas; cada mecanismo precisa ser exercitado na nova instalação.
- Presença da ferramenta num conector, documentação do protocolo e sucesso do backend não provam execução da ferramenta na conversa do cliente. Catálogo pode ficar antigo; retestar leitura real após refresh.

## Memória e custo: não copiar por hábito

O Elo tem memória de relacionamento e processamento DeepSeek. Na evolução por blocos: até 20 fontes/12 mil caracteres do mesmo contato, janela de duas horas, três blocos a cada dez minutos, cota padrão 200 chamadas/dia UTC, divisões/retries limitados. Exceder cota mantém captura e deixa extração na fila; retenção pode vencer antes da fila se houver atraso prolongado.

Esses números não dimensionam grupos. O objetivo aqui é primeiro gerenciar e arquivar WhatsApp: não é necessário chamar LLM por mensagem recebida. Transcrição, OCR, resumo, busca lexical e memória têm propósitos e custos distintos. Resumo não substitui arquivo bruto. Importação por Skill e extrator concorrente já produziram duplicações semânticas no Elo; a solução usa origem/aplicação única, sem prometer deduplicação universal.

## Operação e apresentação

Diagnóstico de configuração não equivale a saúde atual. Último erro pode ser histórico e `pending` pode ser checklist conservador. Datas de última recepção, falha vigente e perda de cobertura devem ser distinguidas. Depois de deploy, conferir versão ativa e chamada real no endereço final; upload não basta. Restauração deve reaplicar migrações, bloquear ações antigas e não restaurar um epoch externo revogado.

Rotinas úteis foram demonstradas como problema → pedido → ferramenta real → resultado. Não narrar HTTP 200 como entrega ou uma revisão manual como agendamento. O dono prefere solução usual e correções conforme problemas reais aparecem, com testes essenciais nas fronteiras que têm efeito.
