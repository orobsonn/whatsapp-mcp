import type {CuratorReceipt,KnowledgeCurator} from './curator';
import {telegramText} from '../telegram-format';
const clip=(text:string,max:number)=>{let value=text;while(telegramText(value).length>max)value=value.slice(0,-1);return telegramText(value);};
/** Descriptions are journal reports; only host receipts confirm writes. */
export async function curatorSummaryText(curator:KnowledgeCurator,receipt:CuratorReceipt){
 const c=receipt.counts,reviewed=c.evaluated+c.learned;
 const [learned,discarded,unconfirmed]=await Promise.all([
  curator.decisions(receipt.id,{limit:3,group:'learned'}),
  curator.decisions(receipt.id,{limit:2,group:'discarded'}),
  curator.decisions(receipt.id,{limit:2,group:'unconfirmed'}),
 ]);
 const lines=[`🧠 <b>${receipt.kind==='sample'?'AMOSTRA DA MEMÓRIA':'REVISÃO DA MEMÓRIA'} · ${telegramText(receipt.window.day)}</b>`,
  `${reviewed} fontes avaliadas; ${c.learned} com aprendizado confirmado.`,
  receipt.state==='complete'?'✅ Revisão concluída.':'⏳ Revisão parcial; há trabalho pendente.'];
 if(receipt.needsHelp&&receipt.helpRequest)lines.push('\n<b>🙋 Preciso de você</b>',clip(receipt.helpRequest,400));
 const example=(item:typeof learned.items[number])=>`• ${clip(item.decision.summary,120)}\n${clip(item.decision.reason,120)}`;
 if(c.learned){
  lines.push('\n<b>🧠 Gravei na memória</b>');
  const contexts=new Map<string,typeof learned.items>();
  for(const item of learned.items){const key=item.decision.context??'Outros assuntos';contexts.set(key,[...(contexts.get(key)??[]),item]);}
  for(const [context,items] of contexts)lines.push(`<b>📁 ${clip(context,80)}</b>`,...items.map(example));
  if(!learned.items.length)lines.push('Há gravação confirmada, mas a descrição não foi registrada.');
  if(c.learned>learned.items.length)lines.push(`Exemplos de ${learned.items.length} das ${c.learned} fontes com gravação confirmada.`);
 }else lines.push('\n<b>🧠 Nenhum aprendizado confirmado nesta passagem.</b>');
 if(discarded.items.length)lines.push('\n<b>🗑️ Não guardei · exemplos</b>',...discarded.items.map(example));
 if(unconfirmed.items.length)lines.push('\n<b>🔎 Ainda sem conclusão · exemplos</b>',...unconfirmed.items.map(example),'Falta de evidência não significa conteúdo irrelevante.');
 if(reviewed&&!learned.items.length&&!discarded.items.length&&!unconfirmed.items.length)lines.push('As decisões não têm descrição registrada; não é possível afirmar por que cada conteúdo foi descartado.');
 const pending=c.pending+c.presented;
 if(pending||c.indexing||c.unavailable||c.capturePending){
  lines.push('\n<b>🔧 Pendências do sistema</b>');
  if(pending)lines.push(`• ${pending} fontes com avaliação não concluída. ${receipt.kind==='daily'?'Entram como pendência da próxima revisão diária.':'A amostra permanece parcial; não agenda continuação na rotina diária.'}`);
  if(c.indexing)lines.push(`• ${c.indexing} fontes aguardam confirmação da gravação; ainda não contam como aprendizado.`);
  if(c.unavailable)lines.push(`• ${c.unavailable} fontes não puderam ser verificadas. Permanecem pendentes para nova verificação.`);
  if(c.capturePending){
   lines.push(`• ${c.capturePending} eventos de captura pendentes na integração. Atualizações podem repetir a mesma referência; não é uma contagem de conteúdos perdidos.`);
   const details=receipt.captureDiagnostics??[];
   const kinds:Record<string,string>={message:'mensagem',media:'mídia',derivative:'transcrição/derivado',conversation:'conversa'};
   const reasons:Record<string,string>={message_unavailable:'corpo da mensagem indisponível no arquivo',media_unavailable:'mídia indisponível para o leitor',reader_timeout:'tempo de leitura excedido'};
   for(const d of details.slice(0,4))lines.push(`  • ${d.events} eventos de ${kinds[d.kind]??'origem'} (${d.references} referência(s)): ${d.reason?'última leitura: ':''}${reasons[d.reason??'']??(d.reason?'leitura não concluída':'processamento ainda não concluído')}.`);
   if(details.length>4)lines.push(`  • ${details.slice(4).reduce((sum,d)=>sum+d.events,0)} outros eventos com leitura ou processamento pendente.`);
   const retry=details.reduce((sum,d)=>sum+d.retryScheduled,0);
   if(retry)lines.push(`${retry} eventos têm nova tentativa prevista na integração; isso não garante recuperação.`);
   lines.push('A integração precisa disponibilizar essas fontes antes da análise; não há ação sua solicitada para essa fila.');
  }
 }
 if(receipt.kind==='sample')lines.push('Esta é uma amostra pontual; não altera a rotina diária.');
 lines.push('\n💬 Para orientar a curadoria, responda pelo assunto: “Sobre [assunto], guarde/corrija/ignore…”.');
 // Bounded examples and diagnostics fit one Telegram message without cutting HTML.
 const bounded:string[]=[];let used=0,omitted=false;
 for(const line of lines){if(used+line.length+1>3900){omitted=true;continue;}bounded.push(line);used+=line.length+1;}
 if(omitted)bounded.push('Outros detalhes permanecem no diário privado.');
 return bounded.join('\n');
}
