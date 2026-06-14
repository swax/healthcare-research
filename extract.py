"""One-time extractor: serialize the cleaned 16-sheet workbook + graph into data/data.json.
After this, data/data.json is the single source of truth; build.ts regenerates everything."""
import openpyxl, json

SRC='/tmp/v4_built.xlsx'
wb=openpyxl.load_workbook(SRC)

def hexc(color):
    try:
        rgb=color.rgb
        if isinstance(rgb,str) and len(rgb)==8: return rgb[2:]
    except Exception: pass
    return None

def tab_color(ws):
    tc=ws.sheet_properties.tabColor
    if tc is None: return None
    rgb=getattr(tc,'rgb',None) or (tc if isinstance(tc,str) else None)
    if isinstance(rgb,str) and len(rgb)==8: return rgb[2:]
    if isinstance(rgb,str) and len(rgb)==6: return rgb
    return None

def cell_style(c):
    s={}
    f=c.font
    if f:
        if f.bold: s['b']=True
        if f.size and f.size!=11: s['sz']=f.size
        col=hexc(f.color) if f.color else None
        if col and col!='000000': s['color']=col
    fill=c.fill
    if fill and fill.patternType=='solid':
        fg=hexc(fill.fgColor)
        if fg: s['fill']=fg
    a=c.alignment
    if a:
        if a.horizontal: s['h']=a.horizontal
        if a.vertical: s['v']=a.vertical
        if a.wrap_text: s['wrap']=True
        if a.indent: s['indent']=a.indent
    if c.number_format and c.number_format!='General': s['fmt']=c.number_format
    return s

sheets=[]
for ws in wb.worksheets:
    cells=[]
    for row in ws.iter_rows():
        for c in row:
            has_fill = bool(c.fill and c.fill.patternType=='solid' and hexc(c.fill.fgColor))
            if c.value is None and not has_fill: continue
            cd={'r':c.row,'c':c.column}
            v=c.value
            if isinstance(v,str) and v.startswith('='): cd['f']=v
            elif v is not None: cd['v']=v
            st=cell_style(c)
            if st: cd['s']=st
            cells.append(cd)
    sheets.append({
        'name':ws.title,
        'tabColor':tab_color(ws),
        'gridlines':bool(ws.sheet_view.showGridLines),
        'freeze':ws.freeze_panes,
        'columns':{k:round(d.width,2) for k,d in ws.column_dimensions.items() if d.width},
        'rows':{str(r):round(d.height,2) for r,d in ws.row_dimensions.items() if d.height},
        'merges':[str(m) for m in ws.merged_cells.ranges],
        'cells':cells,
    })

# ---- canonical graph (single source of truth for flows/viz) ----
NODES=[
 ('Individuals',0,'Payers / Households','1565C0'),('Employers',0,'Payers / Households','1565C0'),
 ('Federal Government',1,'Government','0D47A1'),('State Governments',1,'Government','0D47A1'),
 ('Medicare',2,'Programs & Insurers','00838F'),('Medicaid',2,'Programs & Insurers','00838F'),
 ('Health Insurance',2,'Programs & Insurers','00838F'),
 ('Hospitals',3,'Providers','2E7D32'),('Providers & Clinicians',3,'Providers','2E7D32'),
 ('Pharma & Rx',3,'Providers','2E7D32'),('Long-Term Care',3,'Providers','2E7D32'),
 ('Healthcare Workers',4,'Factors of Production','6A1B9A'),('Suppliers & Vendors',4,'Factors of Production','6A1B9A'),
]
EDGES=[
 ('Individuals','Federal Government',437,'General revenue','CMS NHE / Trustees'),
 ('Federal Government','Medicare',437,'General revenue funding','CMS NHE / Trustees'),
 ('Individuals','Medicare',162.5,'Payroll tax (employee HI)','Trustees Report'),
 ('Individuals','Medicare',163,'Beneficiary premiums','CMS / Trustees'),
 ('Individuals','Federal Government',614,'General revenue','MACPAC / CMS-64'),
 ('Federal Government','Medicaid',614,'Federal share (FMAP)','MACPAC / CMS-64'),
 ('Individuals','State Governments',280,'State taxes','MACPAC / CMS-64'),
 ('State Governments','Medicaid',280,'State share','MACPAC / CMS-64'),
 ('Employers','Health Insurance',830,'ESI premiums','KFF EHBS 2023'),
 ('Employers','Medicare',163,'Payroll tax (employer HI)','Trustees / IRS'),
 ('Individuals','Health Insurance',235,'ESI worker share','KFF EHBS 2023'),
 ('Individuals','Health Insurance',120,'Individual market premiums','CMS NHE'),
 ('Federal Government','Health Insurance',80,'ACA APTC subsidies','CBO / HHS'),
 ('Medicare','Health Insurance',539,'MA Part C capitation','MedPAC / KFF'),
 ('Medicaid','Health Insurance',508,'MCO capitation','MACPAC'),
 ('Medicare','Hospitals',150,'FFS','CMS NHE Table 7'),
 ('Medicare','Providers & Clinicians',95,'FFS','CMS NHE Table 8'),
 ('Medicare','Pharma & Rx',55,'Part D','CMS NHE Table 16'),
 ('Medicare','Long-Term Care',76,'FFS','CMS NHE'),
 ('Medicaid','Hospitals',45,'FFS + DSH','MACPAC'),
 ('Medicaid','Providers & Clinicians',40,'FFS','MACPAC'),
 ('Medicaid','Long-Term Care',170,'LTSS (nursing + HCBS)','MACPAC'),
 ('Medicaid','Pharma & Rx',30,'FFS Rx','MACPAC'),
 ('Individuals','Hospitals',37.525,'Out-of-pocket','CMS NHE Table 7'),
 ('Individuals','Providers & Clinicians',87.295,'Out-of-pocket','CMS NHE Table 8'),
 ('Individuals','Pharma & Rx',55.424,'Out-of-pocket','CMS NHE Table 16'),
 ('Hospitals','Healthcare Workers',810,'Labor (facility-fee)','AHA Annual Survey 2023'),
 ('Providers & Clinicians','Healthcare Workers',1034.7852,'Labor (prof-fee)','CMS NHE'),
 ('Long-Term Care','Healthcare Workers',253.38,'Labor (nursing + home health)','CMS NHE'),
 ('Pharma & Rx','Healthcare Workers',116.5,'Labor (est. 50% Pharma+Insurance split)','estimate'),
 ('Health Insurance','Healthcare Workers',116.5,'Labor (est. 50% Pharma+Insurance split)','estimate'),
 ('Hospitals','Suppliers & Vendors',660,'Non-labor','AHA / CMS NHE'),
 ('Providers & Clinicians','Suppliers & Vendors',257.336,'Non-labor (practice overhead)','estimate'),
 ('Long-Term Care','Suppliers & Vendors',94.85,'Non-labor','estimate'),
 ('Pharma & Rx','Suppliers & Vendors',113.22875,'Non-labor (est. 50% split)','estimate'),
 ('Health Insurance','Suppliers & Vendors',113.22875,'Non-labor (est. 50% split)','estimate'),
]
graph={
 'nodes':[{'id':n,'layer':l,'group':g,'color':c} for n,l,g,c in NODES],
 'edges':[{'from':s,'to':t,'amount':a,'channel':ch,'source':src} for s,t,a,ch,src in EDGES],
}

meta={'title':'2023 U.S. Healthcare Flow-of-Funds','year':2023,'units':'USD billions',
      'sources':'CMS NHE, MedPAC, MACPAC, AHA, KFF, PhRMA',
      'generatedNote':'Edit data/graph.json (small) and re-run `node src/build.ts`. workbook.json is bulk content.'}
# graph.json = the small, human-edited canonical graph
json.dump({'meta':meta,'graph':graph}, open('data/graph.json','w'), ensure_ascii=False, indent=2)
# workbook.json = bulk 16-sheet content (generated; rarely hand-edited)
json.dump({'sheets':sheets}, open('data/workbook.json','w'), ensure_ascii=False, indent=1)
import os
print('wrote data/graph.json', round(os.path.getsize('data/graph.json')/1024,1),'KB |',
      'data/workbook.json', round(os.path.getsize('data/workbook.json')/1024),'KB')
print('sheets:',len(sheets),'| cells:',sum(len(s['cells']) for s in sheets),'| nodes:',len(NODES),'edges:',len(EDGES))
