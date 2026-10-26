# #50 — consulta GitHub pública pelo receiver real

26/10/2026. O Root executou o conector produtivo no Worker próprio, código
`6171513`, por binding nominal OwnerAssistant e operador local privado. Esta
evidência complementa os [testes de autorização/limites](50-github-read.md).
Não prova acesso a repositório privado, catálogo do cliente ou prontidão do piloto.
O autor desta documentação leu somente artefatos locais; não acessou credenciais,
Cloudflare, GitHub upstream ou modelos nesta preparação.

## Escopo e resultados

O ensaio criou projeto e nota de suporte sintéticos, privados ao dono, com
revisão fixada. Só então o host configurou uma allowlist temporária para o
repositório público `orobsonn/whatsapp-mcp`. Não houve token GitHub, importação
do README como owner_note, indexação, inferência, envio ou escrita Calendar.
A nota era suporte administrativo explícito; código consultado continuou dado.

- Commit completo: `f3e99b57d739510e2b9bc452eb8c70fc3b5fa03f`.
- README real: 5214 bytes, blob `9cc6545fe36f1e841dc46572896eb7079b819c03`,
  SHA-256 `9787b2f0e8a8db42387d2ca5c618bce8e38391be49e6fcdae86f0624052ecb3a`.
- A leitura manteve repository/project/configurationVersion, commit e hash,
  `audience=owner`, `execution=unconfirmed` e `deployment=not_observed`.
- Listagem real da raiz: página de uma entrada, seguida pelo cursor confirmado
  de outra página com 21 entradas; as 22 correspondem ao inventário fixado.
  Cobertura passou de `page/incomplete` a `directory_end/complete`, com escopo
  `directory_only`. Isso não anuncia subdiretórios percorridos ou histórico total.
- Repositório fora da allowlist retornou `repository_not_authorized`.
  Depois da retirada da nota, a leitura retornou `source_denied`, sem corpo.

## Falhas preservadas e diagnóstico do harness

A primeira listagem retornou `github_read_failed`, com cobertura desconhecida.
A causa upstream não foi estabelecida; HTTP200 em consulta separada pela VPS
não prova a resposta recebida pelo Worker. O journal preservou essa observação.
Uma única reconciliação explícita do GET, com o mesmo request hash, completou
a página. Foram no máximo quatro tentativas de GET GitHub da aplicação:
README, primeira listagem, sua reconciliação e página final. Não houve retry
automático, alteração do parser produtivo ou tentativa paga repetida.

Os negativos de path URL e campo `url` extra não receberam ACK de sucesso no
harness. Seu reconhecedor esperava detalhes da validação; o RPC real devolveu
somente `Error`, mensagem `ZodError`, perdendo os campos das issues. O operador
original respondeu502. Diagnóstico privado limitado confirmou essa recusa nos
dois inputs sintéticos; o schema produtivo real também os recusa localmente.
Não se inventou erro específico de campo, ACK ou resultado para completar o fluxo.
Essas consultas de validação não são novas leituras GitHub nem chamadas de modelo.

A limpeza permaneceu possível apesar de consultas sem ACK: retirou a nota,
observou sua indisponibilidade e a recusa do conector e conferiu health. A
allowlist temporária foi removida e a configuração anterior relida: três módulos,
26 bindings, namespaces/imagem/runtime, flags pausadas, cron e exposição
preservados. Projeto sintético permaneceu como metadata; operadores/grupos locais
foram encerrados e credenciais efêmeras removidas. Tentativas e logs não foram
apagados. Custo incremental de modelos/APIs pagas: US$0; infraestrutura separada.

## Cinco critérios e fronteiras de prova

| Critério | Prova disponível |
| --- | --- |
| ac-13.241 | GET público real e repo não autorizado recusado; método/domínio/redirect e ACL têm contraprovas locais. |
| ac-13.242 | Commit completo, blob e hash do README real conferidos; cursor vinculado à mesma configuração/commit. |
| ac-13.243 | Resultado real permaneceu owner; suporte retirado negou leitura. Recurso privado simulado e principal extractor recusado têm provas locais; token/repositório privado upstream e interlocutor real não foram observados. |
| ac-13.244 | Páginas reais1+21 cobriram somente as22 entradas fixadas da raiz. Cap1000, cursor divergente e limites continuam provas locais. |
| ac-13.245 | Respostas reais mantiveram execution unconfirmed/deployment not_observed; não se chamou código consultado de implantado. |

A CI integrada [40415132411](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40415132411)
aprovou o código6171513. Esta documentação não executou nova suíte. Integração,
CI exata e release minor continuam gates do coordenador; cliente MCP, fontes
privadas próprias e homologação integrada permanecem identificados separadamente.

## Recibos selecionados

Originais privados preservados sob `local/assistant-build/personal-shadow-stage/github-cloud-v1/`:

| Arquivo relativo | SHA-256 |
| --- | --- |
| `github.read.ack.private.json` | `89f0e18fca0b8e61df08c706e79ad2ca17ca5b0917670afb14a19fcb3a78bcde` |
| `github.list.first.observation.private.json` | `0970d7263f38648a9f8bb52bf5f6cb59b19d04565ab7ef1a77f904a533855c0b` |
| `github.list.first.reconcile-observation.private.json` | `8c05cb325439562e5a78cddac8d9a7db49288fd375f02441e998f5f9a7c53a48` |
| `github.list.tail.ack.private.json` | `3bdb2e5372df763fad40297e8b928fa25d583de86eca4b40045409502fb10ce1` |
| `github.denied_repository.ack.private.json` | `5fc99d7e45fa074d569b043233bc7c57b901c787d08b618b3fb31dd0b3f01365` |
| `rpc-diagnostic-v1/github.denied_path.observation.private.json` | `7d0b1b0d85930e11a41e21f61431d293c026bc205f8b7a536a0bf764a9811d28` |
| `rpc-diagnostic-v1/github.denied_url.observation.private.json` | `51617eb8a92a93413598fe538859325f767b95bc012ee521594ddc4b07e1eca5` |
| `github.withdrawn.ack.private.json` | `0398569fa937332fe8c9af463684e4977187fea75953f80ce39ad1ed44d80b56` |
| `teardown.verified.private.json` | `02e45fa4b51e901c2ae7801ba8358d48f47f52bd62f2116c1a663063b4e31559` |
| `configuration.restored.private.json` | `ee7c8aecaee602565dd7c01e863331409b37deacfab78600da03efff6a3afdab` |
