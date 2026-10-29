// Relationships between loaded tables, for the data model viewer (like Qlik's data model viewer).
export type GraphTable={name:string;columns:{name:string;type:string}[];rows?:number|null;source?:string|null;subtitle?:string}
export type GraphLink={a:string;b:string;fields:[string,string][];kind:'link'|'shared'}

const KEY_LIKE=/(^id$|_id$|_no$|_code$|_key$|^code$|_number$|_num$)/
const IGNORED=new Set(['_bi_loaded_at','modified_at','created_at','updated_at','source_file'])

// Tables that share a field name could be associated (Qlik links tables on equal field names).
export function sharedFieldLinks(tables:GraphTable[],options:{keysOnly?:boolean}={}){
  const links:GraphLink[]=[]
  for(let i=0;i<tables.length;i++)for(let j=i+1;j<tables.length;j++){
    const names=new Set(tables[j].columns.map(c=>c.name))
    const fields=tables[i].columns.map(c=>c.name).filter(n=>names.has(n)&&!IGNORED.has(n)&&(!options.keysOnly||KEY_LIKE.test(n)))
    if(fields.length)links.push({a:tables[i].name,b:tables[j].name,fields:fields.map(f=>[f,f] as [string,string]),kind:'shared'})
  }
  return links
}

// The links an app's data model actually uses.
export function modelLinks(model:{alias:string;parent_alias:string|null;join_pairs:[string,string][]}[]):GraphLink[]{
  return model.filter(t=>t.parent_alias).map(t=>({a:t.alias,b:t.parent_alias!,fields:t.join_pairs,kind:'link' as const}))
}

// Columns of tables by distance from the most connected table; separate groups below each other.
export function layoutGraph(names:string[],links:GraphLink[],heights:Record<string,number>,boxWidth=220,gapX=90,gapY=28){
  const adj=new Map(names.map(n=>[n,new Set<string>()]))
  for(const l of links){adj.get(l.a)?.add(l.b);adj.get(l.b)?.add(l.a)}
  const pos=new Map<string,{x:number;y:number}>()
  const left=new Set(names);let top=0
  while(left.size){
    const start=[...left].sort((a,b)=>(adj.get(b)!.size-adj.get(a)!.size)||a.localeCompare(b))[0]
    const layer=new Map<string,number>([[start,0]]);const queue=[start]
    while(queue.length){const n=queue.shift()!;for(const m of [...adj.get(n)!].sort())if(!layer.has(m)&&left.has(m)){layer.set(m,layer.get(n)!+1);queue.push(m)}}
    const byLayer=new Map<number,string[]>()
    for(const [n,l] of layer){byLayer.set(l,[...(byLayer.get(l)||[]),n]);left.delete(n)}
    let bottom=top
    for(const [l,list] of [...byLayer.entries()].sort((a,b)=>a[0]-b[0])){let y=top
      for(const n of list.sort((a,b)=>a.localeCompare(b))){pos.set(n,{x:20+l*(boxWidth+gapX),y});y+=(heights[n]||100)+gapY}
      bottom=Math.max(bottom,y)}
    top=bottom+gapY
  }
  return pos
}
