# Verificador INDEPENDENTE (Python/pandas, sem usar nenhum código do sistema): reexecuta as missões onda a onda sobre a planilha de estoque.
# Uso: python3 scripts/verificar-missoes.py controle-estoque.xlsx controle-missoes.json [máx_violações_listadas] [cxp.json]
# Regras: PAIOL, CX-FECHADA, SC-LIMITE, SC-NIVEL, SC-VAZIA, SC-1PI (final), ORIGEM, FR-LIMITE, FR-1PI.
import sys, json, math, collections, os
import pandas as pd
estoque, arq_missoes = sys.argv[1], sys.argv[2]
MAX_SC, MAX_SC_CAL, MAX_FR, MAX_FR_CAL, CX_COMPART, NIVEL_REP = 12, 10, 5, 3, 2, 2
CAL = {"SAPATO","COTURNO","BOTA","TENIS","MOCASSIM","SANDALIA","CHINELO","BOTINA"}
d = pd.read_excel(estoque)
d = d[d.DEPOSITO.isin(["P01","P02","P03","P04","P05","P06"])].copy()
d = d[d.PI.astype(str).str.upper()!="VAZIO"].copy()  # linhas de posição vazia não são saldo
d["PI"] = d.PI.astype(str); d["DISP"]=d.DISPONIVEL.astype(float); d["TOT"]=d.TOTAL.astype(float)
cxp = d.dropna(subset=["CXP"]).groupby("PI").CXP.first().to_dict() if "CXP" in d else {}
if len(sys.argv)>4 and os.path.exists(sys.argv[4]): cxp.update(json.load(open(sys.argv[4])))  # CXP vinda dos pedidos para PIs sem CXP na planilha
desc = d.groupby("PI").DESCRICAO.first().to_dict()
cal = lambda pi: str(desc.get(pi,"")).strip().split(" ")[0].upper() in CAL
nivel = lambda end: int(str(end).split("-")[2]) if len(str(end).split("-"))>2 else 0
raw = json.load(open(arq_missoes))
ms = raw["missoes"] if isinstance(raw, dict) and "missoes" in raw else raw
ms = list(ms.values()) if isinstance(ms, dict) else ms
ms = [m for m in ms if m.get("status") in (None,"pendente","em_execucao","feita")]
zona = set((raw.get("zona") or {}).values()) if isinstance(raw, dict) else set()
fr = collections.defaultdict(lambda: collections.defaultdict(float)); frlivre = collections.defaultdict(lambda: collections.defaultdict(float))
sc = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0,0.0]))  # loc -> pi -> [total, livre]
area_loc = collections.defaultdict(set)
for r in d.itertuples():
    k=(r.DEPOSITO,str(r.ENDERECO)); area_loc[k].add(r.AREA)
    if r.AREA=="FR":
        fr[k][r.PI]+=r.DISP
        if r.STATUS=="LIVRE": frlivre[k][r.PI]+=r.DISP
    if r.AREA=="SC" and r.TOT>0:
        sc[k][r.PI][0]+=r.TOT
        if r.STATUS=="LIVRE": sc[k][r.PI][1]+=r.DISP
def caixas_sc(k):
    v=0.0
    for pi,(q,l) in sc[k].items():
        if q<=1e-6: continue
        c=cxp.get(pi)
        if not c: return math.inf
        v+=q/c
    return v
def pis_sc(k): return [pi for pi,(q,l) in sc[k].items() if q>1e-6]
viol=[]; n=collections.Counter()
def V(m,reg,txt): viol.append((m["id"],reg,txt))
tocadas={}
for onda in sorted({m["onda"] for m in ms}):
    wave=sorted([m for m in ms if m["onda"]==onda], key=lambda m:m["id"])
    saiu=collections.Counter(); chegou=collections.defaultdict(float); chegou_pi=collections.defaultdict(set); ef=[]
    cxsc=collections.defaultdict(float); pisc=collections.defaultdict(set)
    for m in wave:
        de=(m["de"]["dep"],m["de"]["end"]); pa=(m["para"]["dep"],m["para"]["end"]); pi=m["pi"]; c=cxp.get(pi); q=float(m["qtd"]); sub=m.get("sub")
        origem_sc = m["tipo"]=="recompletamento" or bool(sub)
        n["ORIGEM"]+=1
        if origem_sc:
            livre=sc[de][pi][1]-saiu[(pi,de)] if pi in sc[de] else 0
            if livre<q-1e-6: V(m,"ORIGEM",f"SC {de[1]} tem {livre} livres, pede {q}")
        else:
            livre=frlivre[de].get(pi,0)-saiu[(pi,de)]
            if livre<q-1e-6: V(m,"ORIGEM",f"origem {de[1]} tem {livre} livres, pede {q}")
        saiu[(pi,de)]+=q
        if m["tipo"]=="movimentacao":
            n["PAIOL"]+=1
            if de[0]!=pa[0]: V(m,"PAIOL",f"{de}→{pa}")
        if m["tipo"]=="recompletamento" and c:
            n["CX-FECHADA"]+=1
            if abs(q/c-round(q/c))>1e-6: V(m,"CX-FECHADA",f"recompletamento {q} não é múltiplo de {c}")
        destino_fr = m["tipo"]=="recompletamento" or (not sub and m.get("motivo","").startswith(("Juntar","Faltam LOCs","Levar para")))
        if not destino_fr:
            lim = MAX_SC_CAL if cal(pi) else MAX_SC
            outros=[p for p in pis_sc(pa) if p!=pi]; chegando=[p for p in pisc[pa] if p!=pi]
            if not sub:
                n["CX-FECHADA"]+=1
                if not c: V(m,"CX-FECHADA","sem CXP")
                elif abs(q/c-round(q/c))>1e-6: V(m,"CX-FECHADA",f"{q} não é múltiplo de {c}")
                if "FR" in area_loc.get(pa,set()): V(m,"SC-LIMITE",f"destino {pa[1]} é LOC de FR")
            propria = sub=="desmisturar" and not outros and not chegando and pi in sc[pa] and sc[pa][pi][0]>1e-6
            if sub in ("descer","desmisturar") and not propria:
                n["SC-VAZIA"]+=1
                if outros or chegando or (pi in sc[pa] and sc[pa][pi][0]>1e-6): V(m,"SC-VAZIA",f"LOC {pa[1]} não está vazia")
            else:
                n["SC-NIVEL"]+=1
                if nivel(pa[1])!=NIVEL_REP: V(m,"SC-NIVEL",f"{pa[1]} é altura {nivel(pa[1])}, caixas soltas só na {NIVEL_REP}")
                n["SC-LIMITE"]+=1
                atual=caixas_sc(pa); apos=atual+cxsc[pa]+(q/c if c else 0)
                if atual==math.inf: V(m,"SC-LIMITE",f"LOC {pa[1]} tem PI sem CXP")
                elif apos>lim+1e-6: V(m,"SC-LIMITE",f"LOC SC {pa[1]} fica com {apos:.1f} cx (limite {lim})")
            if sub=="descer":
                n["SC-NIVEL"]+=1
                if nivel(pa[1])!=NIVEL_REP or nivel(de[1])<=NIVEL_REP: V(m,"SC-NIVEL",f"descer {de[1]} → {pa[1]}")
            cxsc[pa]+= (q/c if c else 0); pisc[pa].add(pi); tocadas[pa]=m
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
        ef.append((m,destino_fr,origem_sc))
    for m,destino_fr,origem_sc in ef:
        de=(m["de"]["dep"],m["de"]["end"]); pa=(m["para"]["dep"],m["para"]["end"]); pi=m["pi"]; q=float(m["qtd"])
        if origem_sc:
            if pi in sc[de]:
                sc[de][pi][0]-=q; sc[de][pi][1]-=q
                if sc[de][pi][0]<=1e-6: del sc[de][pi]
        else:
            fr[de][pi]-=q; frlivre[de][pi]-=q
            if fr[de][pi]<=1e-6 and pi in fr[de]: del fr[de][pi]
        if destino_fr: fr[pa][pi]+=q; frlivre[pa][pi]+=q
        else: sc[pa][pi][0]+=q; sc[pa][pi][1]+=q
for k,m in tocadas.items():
    n["SC-1PI"]+=1
    if len(pis_sc(k))>1: V(m,"SC-1PI",f"LOC SC {k[1]} termina com {pis_sc(k)[:3]}")
print(f"missões verificadas: {len(ms)} | checagens: {dict(n)} | VIOLAÇÕES: {len(viol)}")
por=collections.Counter(r for _,r,_ in viol); print(dict(por))
for v in viol[:int(sys.argv[3]) if len(sys.argv)>3 else 10]: print(" ",*v)
