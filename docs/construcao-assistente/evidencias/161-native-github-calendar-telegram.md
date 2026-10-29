# Telegram nativo: respostas reais com GitHub e Google Calendar

Ensaio controlado no bot vinculado em 29/10/2026, sobre a versão própria `94d20d6f-bfa3-4b53-88a6-9c8615457b1e`. As perguntas foram digitadas na interface autenticada do Telegram; nenhuma resposta foi pré-preenchida no modelo.

## GitHub

Pedido: consultar `orobsonn/whatsapp-mcp` e explicar como a aplicação evita repetir envio após uma tentativa incerta, sem substituir a resposta por trechos.

O fluxo real usou `github_resolve`, `github_list` e `github_read`, sem erros de ferramenta. O bot explicou a ação persistente, a aquisição condicional da tentativa única, a conservação do estado incerto e a reconciliação posterior sem reenvio automático. A explicação coincide com o executor Source. `respond_owner` concluiu e o transporte privado registrou mensagem 118 enviada no tópico de validação.

Essa prova é sobre consulta e síntese com credencial somente leitura. Não foi executada escrita em repositório pelo bot.

## Google Calendar

Pedido: consultar a agenda de 29/10/2026, com o cabeçalho e linhas de horário/título definidos pelo dono, sem alterar eventos.

- `calendar_availability` retornou `available`, três eventos e cobertura completa daquela consulta.
- A resposta contém o cabeçalho `SUA AGENDA - 29/10/2026` e três linhas `[HH:mm] - TÍTULO`.
- Os três títulos retornados pelo conector aparecem na resposta, comparados após normalização de caixa, espaços e marcação visual.
- `respond_owner` concluiu e o transporte privado registrou mensagem 120 enviada.
- Nenhum evento foi criado, editado ou excluído neste ensaio. Essa consulta não é nova prova de CRUD.

## Verificação

O recebimento/admissão foi conferido no D1 próprio. Chamadas e resultados foram conferidos por SELECT na projeção nativa de conversa do Durable Object, através do endpoint oficial de consulta da Cloudflare. As consultas registraram `rows_written=0`; não foi criado endpoint administrativo, fonte artificial ou ferramenta adicional para observar o teste.

IDs de conversa, tokens, títulos pessoais da agenda e conteúdo privado não acompanham esta evidência. O transporte enviado não comprova que o dono leu a mensagem. A homologação de envio WhatsApp após aprovação humana continua separada.
