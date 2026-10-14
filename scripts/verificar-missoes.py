# Verificador INDEPENDENTE (Python/pandas, sem usar nenhum código do sistema): reexecuta as missões onda a onda sobre a planilha de estoque.
# Uso: python3 scripts/verificar-missoes.py controle-estoque.xlsx controle-missoes.json [máx_violações_listadas] [cxp.json]
import sys, json, math, collections
import pandas as pd
estoque, arq_missoes = sys.argv[1], sys.argv[2]
MAX_SC, MAX_SC_CAL, MAX_FR, MAX_FR_CAL, CX_COMPART = 12, 10, 5, 3, 2
CAL = {"SAPATO","COTURNO","BOTA","TENIS","MOCASSIM","SANDALIA","CHINELO","BOTINA"}
d = pd.read_excel(estoque)
d = d[d.DEPOSITO.isin(["P01","P02","P03","P04","P05","P06"])].copy()
d["PI"] = d.PI.astype(str); d["DISP"]=d.DISPONIVEL.astype(float); d["TOT"]=d.TOTAL.astype(float)
cxp = d.dropna(subset=["CXP"]).groupby("PI").CXP.first().to_dict() if "CXP" in d else {}
import os
if len(sys.argv)>4 and os.path.exists(sys.argv[4]): cxp.update(json.load(open(sys.argv[4])))  # CXP vinda dos pedidos para PIs sem CXP na planilha
desc = d.groupby("PI").DESCRICAO.first().to_dict()
cal = lambda pi: str(desc.get(pi,"")).strip().split(" ")[0].upper() in CAL
raw = json.load(open(arq_missoes))
ms = raw["missoes"] if isinstance(raw, dict) and "missoes" in raw else raw
ms = list(ms.values()) if isinstance(ms, dict) else ms
ms = [m for m in ms if m.get("status") in (None,"pendente","em_execucao","feita")]
zona = set((raw.get("zona") or {}).values()) if isinstance(raw, dict) else set()
# estoque FR (livre+bloqueado por disp) e caixas em SC (todos os PIs, total)
fr = collections.defaultdict(lambda: collections.defaultdict(float)); frlivre = collections.defaultdict(lambda: collections.defaultdict(float))
sc_cx = collections.defaultdict(float); sc_desconhecido=set(); area_loc = collections.defaultdict(set)
for r in d.itertuples():
    k=(r.DEPOSITO,str(r.ENDERECO)); area_loc[k].add(r.AREA)
    if r.AREA=="FR": 
        fr[k][r.PI]+=r.DISP
        if r.STATUS=="LIVRE": frlivre[k][r.PI]+=r.DISP
    if r.AREA=="SC" and r.TOT>0:
        c=cxp.get(r.PI)
        if c: sc_cx[k]+=r.TOT/c
        else: sc_desconhecido.add(k)
sc_livre = collections.defaultdict(float)
for r in d[(d.AREA=="SC")&(d.STATUS=="LIVRE")].itertuples(): sc_livre[str(int(r.ID_QUANT))]+=r.DISP
viol=[]; n=collections.Counter()
def V(m,reg,txt): viol.append((m["id"],reg,txt))
usado_sc=collections.Counter()
for onda in sorted({m["onda"] for m in ms}):
    wave=sorted([m for m in ms if m["onda"]==onda], key=lambda m:m["id"])
    saiu=collections.Counter(); chegou=collections.defaultdict(float); chegou_pi=collections.defaultdict(set); ef=[]
    for m in wave:
        de=(m["de"]["dep"],m["de"]["end"]); pa=(m["para"]["dep"],m["para"]["end"]); pi=m["pi"]; c=cxp.get(pi); q=float(m["qtd"])
        if m["tipo"]=="movimentacao":
            n["PAIOL"]+=1
            if de[0]!=pa[0]: V(m,"PAIOL",f"{de}→{pa}")
            n["ORIGEM"]+=1
            disp=frlivre[de].get(pi,0)-saiu[(pi,de)]
            if disp<q-1e-6: V(m,"ORIGEM",f"origem {de[1]} tem {disp} livres, pede {q}")
            saiu[(pi,de)]+=q
        else:
            n["ORIGEM"]+=1
            idq=str(m.get("idQuant") or ""); dispsc=sc_livre.get(idq,0)-usado_sc[idq] if idq else 0
            if dispsc<q-1e-6: V(m,"ORIGEM",f"SC tem {dispsc} livres, pede {q}")
            usado_sc[idq]+=q
        destino_fr = m["tipo"]=="recompletamento" or m.get("motivo","").startswith(("Juntar","Faltam LOCs","Levar para"))
        if not destino_fr and "FR" in area_loc.get(pa,set()): V(m,"SC-LIMITE",f"destino {pa[1]} é LOC de FR")
        if not destino_fr:
            n["CX-FECHADA"]+=1
            if not c: V(m,"CX-FECHADA","sem CXP")
            elif abs(q/c-round(q/c))>1e-6: V(m,"CX-FECHADA",f"{q} não é múltiplo de {c}")
            n["SC-LIMITE"]+=1
            lim = MAX_SC_CAL if cal(pi) else MAX_SC
            if pa in sc_desconhecido: V(m,"SC-LIMITE",f"LOC {pa[1]} tem PI sem CXP")
            else:
                sc_cx[pa]+= (q/c if c else 0)
                if sc_cx[pa]>lim+1e-6: V(m,"SC-LIMITE",f"LOC SC {pa[1]} fica com {sc_cx[pa]:.1f} cx (limite {lim})")
        else:
            n["FR-LIMITE"]+=1
            comp = pa[0]+"|"+pa[1] in zona
            cap = min(MAX_FR_CAL if cal(pi) else MAX_FR, CX_COMPART) if comp else (MAX_FR_CAL if cal(pi) else MAX_FR)
            apos = fr[pa].get(pi,0)+chegou[(pi,pa)]+q
            if c and math.floor(apos/c+1e-9)>cap: V(m,"FR-LIMITE",f"LOC {pa[1]} fica com {math.floor(apos/c)} cx (máx {cap}) = {apos} un")
            if not str(m.get("nota","")).startswith("Troca"):
                n["FR-1PI"]+=1
                outros=[p for p,qq in fr[pa].items() if p!=pi and qq>1e-6]+[p for p in chegou_pi[pa] if p!=pi]
                if len(outros)>(1 if comp else 0): V(m,"FR-1PI",f"LOC {pa[1]} ainda tem {outros[:3]}")
            chegou[(pi,pa)]+=q; chegou_pi[pa].add(pi)
        ef.append(m)
    for m in ef:
        de=(m["de"]["dep"],m["de"]["end"]); pa=(m["para"]["dep"],m["para"]["end"]); pi=m["pi"]; q=float(m["qtd"])
        if m["tipo"]=="movimentacao":
            fr[de][pi]-=q; frlivre[de][pi]-=q
            if fr[de][pi]<=1e-6 and pi in fr[de]: del fr[de][pi]
        if m["tipo"]=="recompletamento" or m.get("motivo","").startswith(("Juntar","Faltam LOCs","Levar para")):
            fr[pa][pi]+=q; frlivre[pa][pi]+=q
print(f"missões verificadas: {len(ms)} | checagens: {dict(n)} | VIOLAÇÕES: {len(viol)}")
por=collections.Counter(r for _,r,_ in viol); print(dict(por))
for v in viol[:int(sys.argv[3]) if len(sys.argv)>3 else 10]: print(" ",*v)
