import json,sys,collections
rows=[json.loads(l) for l in open(sys.argv[1])]
by=collections.defaultdict(list)
for r in rows: by[(r['project'],r['path'])].append(r)
def q(xs):
    xs=sorted(xs)
    return f"{xs[len(xs)//2]}/{xs[int(len(xs)*0.9)]}/{xs[-1]}" if xs else '-'
print('median/p90/max ms')
for (proj,p),rs in sorted(by.items()):
    ev=lambda k:[e[k] for r in rs for e in r['events'] if e['name']=='width']
    goto=[e['ms'] for r in rs for e in r['events'] if e['name']=='goto']
    lt=[sum(d for _,d in r['long']) for r in rs]; ltmax=[max([d for _,d in r['long']] or [0]) for r in rs]
    print(f"{proj:15} {p:10} n={len(rs):3} total {q([r['total'] for r in rs]):16} goto {q(goto):14} ping {q(ev('ping')):10} resize {q(ev('resize')):14} raf {q(ev('raf')):12} long-sum {q(lt):14} longest {q(ltmax):12} nodes {max(ev('nodes'))}")
