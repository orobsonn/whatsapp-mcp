# Leitura de mídia antes da decisão de curadoria

A recuperação direcionada da revisão encontrou196 decisões, incluindo81 registros marcadosunavailable. Só duas chamadasmedia_read tinham sido feitas. O cruzamento do saldo mostrou55 arquivos distintos:20JPEG prontos,22áudios com transcrição pronta e13arquivos com falhas/limites já conhecidos. Vinte das22transcrições já tinham algum recibo deavaliação; isso não comprova memória gravada. Esses81registros não eram81falhas externas comprovadas.

O patch passa a exigir recibo host-only porrun/SourceRef exato para mídia bruta. O guard vale noACK, antes da intenção deescrita e na reconciliação ready. Sem leitura completa, a única confirmação permitida é indisponibilidade após tentativa real, com insuficiência/adiamento. Texto e fontes de transcrição usam a prova textual normal. Recibos completos não são rebaixados por retorno pending concorrente. São descritores pequenos sem conteúdo ou texto de modelo/provedor; retirada/purga osremove.

O recibo registra que o host produziu um resultado de leitura, não que o modelo compreendeu corretamente. O callback ocorre antes da última verificação da exposição; não há I/O depois do snapshot local final antes de publicar conteúdo. Causalidade da decisão continua no journal/modelo; o guard não é auditor semântico.

Áudio original agora procura transcrição canônica do mesmo arquivo/versão/hash, mensagem/versão, chat e namespace. Refaz ACLs, provas e exposição conjunta antes de devolver o texto com a SourceRef da transcrição. Isso precede configuração/chave do modelo visual e nãoexecutaASRnova.

Dois testes novos reproduzem fatos do incidente: recusaACK/intent semleitura, tentativa não autoriza descarte e prova completa monotônica autoriza decisão; áudio original devolve sua transcrição com processamento visual desligado e zero nova inferência. Os40testes focados eTypeScript passaram. Suíte geral, publicação e nova recuperação são provas separadas.
