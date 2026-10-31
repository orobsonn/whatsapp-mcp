import type {CuratorReceipt,KnowledgeCurator} from './curator';
import {telegramText} from '../telegram-format';
const clip=(text:string,max:number)=>{let value=text;while(telegramText(value).length>max)value=value.slice(0,-1);return telegramText(value);};
const labels={learn:'Aprendizado proposto',already_known:'Já estava na memória',not_useful:'Sem informação duradoura',insufficient_evidence:'Evidência insuficiente',defer:'Decisão adiada'};
/** No model call. Descriptions come from the journal, confirmations from host receipts. */
export async function curatorSummaryText(curator:KnowledgeCurator,receipt:CuratorReceipt){
 const c=receipt.counts,reviewed=c.evaluated+c.learned;
 const [learned,other]=await Promise.all([curator.decisions(receipt.id,{limit:3,group:'learned'}),curator.decisions(receipt.id,{limit:3,group:'other'})]);
 const lines=[`${receipt.state==='complete'?'✅':'⏳'} <b>${receipt.kind==='sample'?'AMOSTRA DA MEMÓRIA':'REVISÃO DA MEMÓRIA'} — ${telegramText(receipt.window.day)}</b>`,
  `${reviewed} fontes avaliadas; ${c.learned} com aprendizado confirmado.`,
  `Revisão ${telegramText(receipt.id.slice(0,8))}${receipt.kind==='sample'?' · amostra pontual':''}.`];
 const examples=(items:typeof learned.items)=>items.map(item=>`• [${item.sequence}] ${clip(item.decision.summary,150)}\n  ${telegramText(labels[item.decision.category])}: ${clip(item.decision.reason,180)}`);
 if(c.learned){lines.push('\n<b>Gravei na memória — exemplos</b>',...examples(learned.items));if(!learned.items.length)lines.push('Há gravação confirmada, mas a descrição da decisão não foi registrada.');if(c.learned>learned.items.length)lines.push(`Mostrando ${learned.items.length} de ${c.learned} fontes com aprendizado.`);}
 else lines.push('\n<b>Nenhum aprendizado confirmado nesta passagem.</b>');
 if(other.items.length)lines.push('\n<b>Não guardei / ainda sem confirmação</b>',...examples(other.items));
 if(other.nextAfter)lines.push('Exemplos selecionados; há outras decisões no diário.');
 if(reviewed&&!learned.items.length&&!other.items.length)lines.push('As decisões desta execução não têm descrição registrada; não é possível afirmar por que cada conteúdo foi descartado.');
 const pending=c.pending+c.presented;
 if(pending||c.indexing||c.unavailable||c.capturePending){
  lines.push('\n<b>O que ficou pendente</b>');
  if(pending)lines.push(`• ${pending} registros ainda sem avaliação concluída.`);
  if(c.indexing)lines.push(`• ${c.indexing} aguardam confirmação da escrita na memória.`);
  if(c.unavailable)lines.push(`• ${c.unavailable} fontes não puderam ser lidas/verificadas.`);
  if(c.capturePending)lines.push(`• ${c.capturePending} registros capturados ainda sem conteúdo disponível para esta revisão.`);
 }
 if(c.skipped_policy)lines.push(`Fora da análise por suas políticas: ${c.skipped_policy}.`);
 if(c.withdrawn+c.superseded)lines.push(`Retirados ou substituídos por outra versão: ${c.withdrawn+c.superseded}.`);
 if(receipt.needsHelp&&receipt.helpRequest)lines.push('\n<b>Preciso que você esclareça</b>',clip(receipt.helpRequest,500));
 else if(receipt.state==='partial')lines.push('Essas pendências não significam que você precise tomar uma decisão.');
 if(receipt.kind==='sample')lines.push('Esta amostra não altera a rotina diária.');
 lines.push('\nPara orientar a próxima revisão, responda citando o item [número] e o que deveria ter sido guardado ou ignorado.');
 // Every free-text fragment is bounded before HTML escaping. Six examples fit one Telegram message.
 return lines.join('\n');
}
