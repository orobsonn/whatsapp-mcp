# Sequência sugerida e validação

Plano de partida para a próxima autorização de implementação. Não há fila, issues ou goal iniciados. O objetivo amplo permanece em `01-escopo-e-jornadas.md`; fatiar é forma de testar, não retirar grupos/arquivos do produto.

## Antes de codar

Confirmar a instância/número/ambiente destinados ao projeto sem alterar o Elo; escolher provedor real para a primeira fatia; definir exposição mínima à IA, retenção inicial e autorização das ações; conferir harness/stack/licenças. Resolver engenharia a partir das referências, sem pedir ao dono que valide banco ou segurança. Perguntas ao dono só para escolhas que mudem seu uso.

## Marcos coesos

1. **Conectar e ler um grupo de teste:** autenticação MCP, diagnóstico real, grupos/contatos, recepção de texto, autoria e busca limitada. Repetir callbacks e capturar mensagem própria do telefone, Web e MCP quando cada superfície for autorizada. Informar claramente se só temos captura desde a ativação.
2. **Enviar texto e salvar saída:** individual + grupo, proposta e autorização conforme política, ação única, status conciliado e busca posterior da mensagem. Recuperar timeout/estado incerto sem duplicar. Não declarar o marco só por ter `messageId`.
3. **Imagem/PDF no mesmo grupo:** upload/referência privada, hash/legenda e envio vinculado, recebimento/persistência/download, busca por metadados. Testar cada formato e tamanho representativo; não precisar de OCR para simplesmente enviar.
4. **Áudio utilizável:** receber/guardar e processar áudio selecionado, identificar limites de formato, idioma e duração; transcrição separada do original. Provar envio de áudio se entrar na prioridade, distinguindo nota de voz de arquivo. O transcritor e o tratamento de dados precisam ser conhecidos.
5. **Arquivo e gerenciamento diário:** política de retenção/exports/exclusão/derivados, eventual backfill demonstrável, organizar chats e operações de grupo realmente priorizadas. Descrever lacunas e operação de recuperação.

A primeira fatia não precisa de auto-resumo por mensagem, memória semântica universal, painel ou agendador próprio. Só acrescentar quando trouxer resultado concreto.

## Matriz mínima de ensaio

| Dimensão | Casos essenciais |
|---|---|
| Destino | Individual, grupo, dois grupos/pessoas com mesmo nome, grupo renomeado, número/conexão trocados |
| Autoria | Recebida de terceiro, própria; participante de grupo separado do chat; origem desconhecida preservada |
| Origem | Telefone, Web, API/MCP: um caso real para cada capacidade anunciada |
| Tipo | Texto, legenda+imagem, PDF, áudio curto/mais longo; mídia ausente/expirada/sem permissão |
| Eventos | Replay, concorrência, status antes do corpo, edição, exclusão, conteúdo tardio, reconexão |
| Consulta | Pessoa/grupo/período/autor/tipo/termo, várias páginas, limite de bytes e cobertura incompleta |
| Envio | Sem autorização, alvo ambíguo, mudança de arquivo/texto, ação expirada/cancelada, duas execuções concorrentes, timeout após tentativa |
| Áudio/documento | Arquivo errado, MIME enganoso, tamanho/duração/páginas excedidos, erro de parser/modelo, resultado parcial; instrução hostil dentro do conteúdo |
| Privacidade | Projeção/logs sem segredos, fora do escopo não retorna, object/cache/export com autorização, nenhum envio de base inteira como fallback |
| Mídia/rede | Host/redirect proibido, IP interno, timeout/download interrompido, hash diferente do revisado, URL expirada, revogação de acesso |
| Operação | Stop/retomada, fila limitada, orçamento/custo, worker ativo/saúde, restore isolado e ações antigas bloqueadas |

Esses testes se ampliam conforme o código muda. Evitar testar todas as bordas antes de entregar qualquer uso; priorizar as que trocam destinatário, expõem segredo, duplicam envio ou perdem captura. Não inventar prova real usando mocks.

## Critério da primeira entrega usual

O dono consegue encontrar um grupo, consultar um recorte com autoria, entender um áudio controlado e enviar texto/imagem/PDF para o destino correto, com política de ação clara, estado consultável e mensagem própria guardada sem duplicar. Cada parte pode ser entregue progressivamente, mas o relatório final separa o que foi comprovado do que ficou pendente. Não exigir novo teste no celular sem uma diferença de comportamento que precise realmente do aparelho.

## Evidência

Manter arquivo sanitizado com versão/commit, tipo/origem/destino, IDs internos, contagens e estados observados. Payloads reais e mídia privada ficam fora do Git. Guardar fixtures sintéticas para contratos de grupo/mídia; comprovar cada claim de produção por resultado real específico. Não produzir números de capacidade ou preço com base em multiplicação teórica apenas.
