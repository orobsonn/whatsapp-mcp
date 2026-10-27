# #126 — destinatário individual sem histórico: implementação e limites

A resolução tipada está implementada e publicada no código Source6b4, com testes D1/runtime/MCP, preservação de captura e revisão adversarial. Versão e lock0.45.0 estão preparados sobre9983254, sem mudança funcional; publicação e fechamento exigem os gates de CI/revisão da nova release. Homologação de catálogo/cliente e envio/provedor real continua pendente e **não é anunciada como pronta**. [Matriz e hashes em JSON](126-resolucao-destinatario-vps.json).

## Prova de implementação e publicação de código

`src/recipients.ts` do Source6b4 é byte-exato ao revisado596. O readback privado da versão Source `47e637b5-9a12-416a-a676-49bd444e1775` comprovou código/configuração instalados. Isso é prova de deployment, não chamada do resolvedor pelo cliente. A ferramenta está registrada em `src/mcp.ts:199`, passando pelo MCP autenticado; ela não depende de mensagem anterior nem de salvar contato no aparelho.

A entrada exige `+` seguido de8–15 dígitos, primeiro1–9, e alias opcional limitado. Não infere DDI/nono dígito, LID, telefone ou pessoa por nome. Resolve/reutiliza o endereço individual exato no epoch/generation atuais, protegido por unicidade, kind e vínculo de conexão. `validated_format=true` não significa cadastro no WhatsApp: `registeredOnWhatsApp=unknown` permanece explícito.

Registros existentes não são atualizados. Nome, captura, exceções, `capture_since` e histórico/tombstones permanecem; novo registro segue o trigger0009 e a política global vigente, sem reconfigurá-los. Captura OFF não é proibição de contato por inferência. O retorno informa a captura efetiva; criar referência não recupera histórico.

## Cobertura dos seis critérios

| Critério da issue126 | Evidência | Estado |
| --- | --- | --- |
|1 ferramenta autenticada/entrada estrita/sem envio, contato ou histórico fictício | `recipients.ts`, registro MCP e casos20/42/45/71 de `tests/recipients.test.ts` | Implementado e provado em teste controlado |
|2 contato sem mensagens/novo, preparo de texto e mídias, unicidade/concorrência | Casos24/33/36/55; UNIQUE por endereço/epoch/generation e guard individual | Implementado; inclui perda real do ACK de transação D1 após commit |
|3 aparelho/geração antes/depois de await e na mutação; negativos | Casos48/52/61/64/67, SQL do runtimeConnectionGuard e recheck posterior | Implementado; DB alterado durante/depois de await recusa referência stale |
|4 preservar captura/nome/histórico e novo default atual | Casos24/27/30/39, ON CONFLICT DO NOTHING e trigger0009 inalterado | Implementado, inclusive enabled/disabled/legacy_hold e default global desativado |
|5 D1/runtime/MCP sem envio real e documentação da homologação pendente | HTTP MCP real no runtime com provider simulado GET status/device; jornada Flue nativa adicional da #128 | Cumprido nessa fronteira controlada; cliente/provedor real pendentes explícitos |
|6 revisão, CI e release minor consistentes; não alegar entrega | Revisão original cf3356f, cobertura596 e revisão independente deste pacote; CI596 aprovada | Publicação condicionada a CI verde do commit entregue e versão/lock/changelog/tag/release consistentes, com recibo externo exato |

Os números de casos indicam linhas de referência no código596, não IDs de uma nova execução. Resultados originais RED/GREEN e55/55 dirigidos permanecem no [registro local histórico](126-recipient-resolution-local.json). Seus campos `pending` representam aquele checkpoint e não foram reescritos. A nova composição596 teve [CI40437755775](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40437755775) aprovada,1350 gerais/64 nativos. O caso nativo em `tests/assistant-episodes.test.ts:564` usa workerd/Flue reais com origem/provider sintéticos e verifica envelope imutável/zero capability de envio; não é conexão com WhatsApp real. Esta auditoria não reexecutou suítes.

## Homologação pendente e gates corretos

O critério5 da [issue126](https://github.com/orobsonn/whatsapp-mcp/issues/126) pede expressamente testes D1/runtime/MCP sem tráfego real de envio e documentação do que foi provado e da homologação real pendente. Ele não exige que o catálogo atual do cliente ou uma entrega WhatsApp real estejam homologados antes de concluir a implementação. A [issue46](https://github.com/orobsonn/whatsapp-mcp/issues/46) tem gate explícito de homologação cloud/cliente, que permanece separado.

O backend registra39 ferramentas autenticadas; esta sessão ainda expõe32 antigas, sem resolvedor e assistente. As APIs de gestão inspecionadas não expõem refresh de catálogo/configuração MCP. O [Zap privado1.0.5](https://chatgpt.com/plugins/plugin_asdk_app_6ad665e79d8c81919153d6c969ee9d64) foi publicado pelo operador após revisão independente, com ACK e readback da skill byte-exata (`0a19d6b2e0386cacec1d4b1943933aa4e0ae52672385d4cbb866d473bedd12a9`). A orientação inclui resolvedor e seis ferramentas da assistente, preservando o app pointer, manifests salvo versão, audiência USER/PRIVATE, permissões e instruções legadas. O catálogo desta sessão permaneceu com32 ferramentas após a publicação: skill publicada não prova refresh nem chamada. Atualização/discovery e chamada real no cliente permanecem pendentes; não foi provado que seja necessário reconectar OAuth. Esta tarefa documental não publicou nem alterou plugin.

O diagnóstico MCP existente foi chamado autenticado e respondeu servidor0.40.0, epoch/generation configurados. Os metadados privados preservados contêm somente escalares; não houve persistência de contagens pessoais, envio ou escrita Calendar. Isso comprova acesso autenticado ao comando existente, não teste live da conexão do provedor, refresh de catálogo ou homologação das sete ferramentas novas. A autenticação atual acessível também não sustenta exigir reconexão OAuth por suposição.

Telefone válido, referência local, ação preparada, aceitação do provedor e entrega/leitura são estados diferentes. Nenhum envio real, contato salvo ou histórico fictício foi criado para esta evidência. O envio manual já existente conserva seu preparo e autorização exata; a assistente continua em sombra, sem habilitar WhatsApp automático ou escrita Calendar. Homologação real só poderá afirmar os estados efetivamente observados, sob pedido separado do dono.

A publicação0.45 exige revisão e CI verde no commit entregue, com versão/lock/changelog/tag consistentes. Identificação do commit, run e resultado da nova CI pertence ao [recibo público da release v0.45.0-ci-evidence.json](https://github.com/orobsonn/whatsapp-mcp/releases/download/v0.45.0/v0.45.0-ci-evidence.json); esta observação não antecipa sucesso da CI ou publicação. Execução duplicada cancelada deve ser reportada como cancelada, sem contar como sucesso. Não se acrescenta aqui requisito de uma segunda execução de main. A evidência não anuncia operacionalidade do cliente, do provedor ou do piloto. Custo adicional desta auditoria/documentação: US$0; sem CF, credenciais reais, dados WhatsApp, modelo ou plugin write.
