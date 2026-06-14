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
# Mirrors data/graph.json. graph.json is the day-to-day hand-edited source; this block only
# re-seeds it when folding heavy Excel edits back in. Slug ids decouple identity from labels.
LAYERS=[
 {'n':0,'name':'Payers / Households','x':0.02,'annotation':'Payers'},
 {'n':1,'name':'Government','x':0.26,'annotation':'Government'},
 {'n':2,'name':'Programs & Insurers','x':0.50,'annotation':'Programs & Insurers'},
 {'n':3,'name':'Providers','x':0.74,'annotation':'Providers'},
 {'n':4,'name':'Factors of Production','x':0.98,'annotation':'Factors'},
]
GROUPS=[
 {'id':'payers','label':'Payers / Households','color':'1565C0'},
 {'id':'government','label':'Government','color':'0D47A1'},
 {'id':'programs_insurers','label':'Programs & Insurers','color':'00838F'},
 {'id':'providers','label':'Providers','color':'2E7D32'},
 {'id':'factors','label':'Factors of Production','color':'6A1B9A'},
]
SOURCES={
 'cms_nhe':'CMS NHE','cms_nhe_t7':'CMS NHE Table 7','cms_nhe_t8':'CMS NHE Table 8',
 'cms_nhe_t16':'CMS NHE Table 16','cms_nhe_trustees':'CMS NHE / Trustees',
 'cms_trustees':'CMS / Trustees','trustees':'Trustees Report','trustees_irs':'Trustees / IRS',
 'macpac':'MACPAC','macpac_cms64':'MACPAC / CMS-64','kff_ehbs_2023':'KFF EHBS 2023',
 'cbo_hhs':'CBO / HHS','medpac_kff':'MedPAC / KFF','aha_2023':'AHA Annual Survey 2023',
 'aha_cms_nhe':'AHA / CMS NHE',
 'nhe2024':'CMS NHE 2024 release (CY2023), by service & source of funds','estimate':'Author estimate',
}
# (id, label, layer, group, role)
NODES=[
 ('individuals','Individuals',0,'payers','source'),
 ('employers','Employers',0,'payers','source'),
 ('federal_government','Federal Government',1,'government','intermediary'),
 ('state_governments','State Governments',1,'government','intermediary'),
 ('medicare','Medicare',2,'programs_insurers','intermediary'),
 ('medicaid','Medicaid',2,'programs_insurers','intermediary'),
 ('health_insurance','Health Insurance',2,'programs_insurers','intermediary'),
 ('hospitals','Hospitals',3,'providers','intermediary'),
 ('providers_clinicians','Providers & Clinicians',3,'providers','intermediary'),
 ('pharma_rx','Pharma & Rx',3,'providers','intermediary'),
 ('long_term_care','Long-Term Care',3,'providers','intermediary'),
 ('healthcare_workers','Healthcare Workers',4,'factors','sink'),
 ('suppliers_vendors','Suppliers & Vendors',4,'factors','sink'),
]
# (id, from, to, amount, channel, source, confidence)
EDGES=[
 ('ind_fed_medicare_genrev','individuals','federal_government',437,'General revenue (Medicare)','cms_nhe_trustees','reported'),
 ('fed_medicare_genrev','federal_government','medicare',437,'General revenue funding','cms_nhe_trustees','reported'),
 ('ind_medicare_payroll_ee','individuals','medicare',162.5,'Payroll tax (employee HI)','trustees','reported'),
 ('ind_medicare_premiums','individuals','medicare',163,'Beneficiary premiums','cms_trustees','reported'),
 ('ind_fed_medicaid_genrev','individuals','federal_government',614,'General revenue (Medicaid)','macpac_cms64','reported'),
 ('fed_medicaid_fmap','federal_government','medicaid',614,'Federal share (FMAP)','macpac_cms64','reported'),
 ('ind_state_taxes','individuals','state_governments',280,'State taxes','macpac_cms64','reported'),
 ('state_medicaid_share','state_governments','medicaid',280,'State share','macpac_cms64','reported'),
 ('emp_hi_esi','employers','health_insurance',830,'ESI premiums','kff_ehbs_2023','reported'),
 ('emp_medicare_payroll_er','employers','medicare',163,'Payroll tax (employer HI)','trustees_irs','reported'),
 ('ind_hi_esi_worker','individuals','health_insurance',235,'ESI worker share','kff_ehbs_2023','reported'),
 ('ind_hi_individual_mkt','individuals','health_insurance',120,'Individual market premiums','cms_nhe','reported'),
 ('fed_hi_aca_aptc','federal_government','health_insurance',80,'ACA APTC subsidies','cbo_hhs','reported'),
 ('medicare_hi_ma','medicare','health_insurance',539,'MA Part C capitation','medpac_kff','reported'),
 ('medicaid_hi_mco','medicaid','health_insurance',508,'MCO capitation','macpac','reported'),
 ('hi_hospitals_claims','health_insurance','hospitals',820.5,'Claims (commercial + MA + MCO)','nhe2024','estimate'),
 ('hi_providers_claims','health_insurance','providers_clinicians',740.7,'Claims (commercial + MA + MCO)','nhe2024','estimate'),
 ('hi_pharma_claims','health_insurance','pharma_rx',243.0,'Claims (commercial + MA + MCO)','nhe2024','estimate'),
 ('hi_ltc_claims','health_insurance','long_term_care',278.1,'Claims (commercial + MA + MCO)','nhe2024','estimate'),
 ('medicare_hospitals_ffs','medicare','hospitals',150,'FFS','cms_nhe_t7','reported'),
 ('medicare_providers_ffs','medicare','providers_clinicians',95,'FFS','cms_nhe_t8','reported'),
 ('medicare_pharma_partd','medicare','pharma_rx',55,'Part D','cms_nhe_t16','reported'),
 ('medicare_ltc_ffs','medicare','long_term_care',76,'FFS','cms_nhe','reported'),
 ('medicaid_hospitals_ffs','medicaid','hospitals',45,'FFS + DSH','macpac','reported'),
 ('medicaid_providers_ffs','medicaid','providers_clinicians',40,'FFS','macpac','reported'),
 ('medicaid_ltc_ltss','medicaid','long_term_care',170,'LTSS (nursing + HCBS)','macpac','reported'),
 ('medicaid_pharma_ffs','medicaid','pharma_rx',30,'FFS Rx','macpac','reported'),
 ('ind_hospitals_oop','individuals','hospitals',37.525,'Out-of-pocket','cms_nhe_t7','reported'),
 ('ind_providers_oop','individuals','providers_clinicians',87.295,'Out-of-pocket','cms_nhe_t8','reported'),
 ('ind_pharma_oop','individuals','pharma_rx',55.424,'Out-of-pocket','cms_nhe_t16','reported'),
 ('hospitals_workers_labor','hospitals','healthcare_workers',810,'Labor (facility-fee)','aha_2023','reported'),
 ('providers_workers_labor','providers_clinicians','healthcare_workers',1034.7852,'Labor (prof-fee)','cms_nhe','reported'),
 ('ltc_workers_labor','long_term_care','healthcare_workers',253.38,'Labor (nursing + home health)','cms_nhe','reported'),
 ('pharma_workers_labor','pharma_rx','healthcare_workers',116.5,'Labor (est. 50% Pharma+Insurance split)','estimate','estimate'),
 ('hi_workers_labor','health_insurance','healthcare_workers',116.5,'Labor (est. 50% Pharma+Insurance split)','estimate','estimate'),
 ('hospitals_suppliers_nonlabor','hospitals','suppliers_vendors',660,'Non-labor','aha_cms_nhe','reported'),
 ('providers_suppliers_nonlabor','providers_clinicians','suppliers_vendors',257.336,'Non-labor (practice overhead)','estimate','estimate'),
 ('ltc_suppliers_nonlabor','long_term_care','suppliers_vendors',94.85,'Non-labor','estimate','estimate'),
 ('pharma_suppliers_nonlabor','pharma_rx','suppliers_vendors',113.22875,'Non-labor (est. 50% split)','estimate','estimate'),
 ('hi_suppliers_nonlabor','health_insurance','suppliers_vendors',113.22875,'Non-labor (est. 50% split)','estimate','estimate'),
]
graph={
 'nodes':[{'id':i,'label':l,'layer':ly,'group':g,'role':r} for i,l,ly,g,r in NODES],
 'edges':[{'id':eid,'from':s,'to':t,'amount':a,'channel':ch,'source':src,'confidence':conf}
          for eid,s,t,a,ch,src,conf in EDGES],
}

meta={'title':'2023 U.S. Healthcare Flow-of-Funds','year':2023,'units':'USD billions',
      'sources':'CMS NHE, MedPAC, MACPAC, AHA, KFF, PhRMA',
      'generatedNote':'Canonical graph + source of truth for the Sankey. Nodes/edges use stable slug ids; `label` is the display name. Edit here, then run: node src/build.ts'}
# graph.json = the small, human-edited canonical graph
out={'meta':meta,'layers':LAYERS,'groups':GROUPS,'sources':SOURCES,'graph':graph}
json.dump(out, open('data/graph.json','w'), ensure_ascii=False, indent=2)
# workbook.json = bulk 16-sheet content (generated; rarely hand-edited)
json.dump({'sheets':sheets}, open('data/workbook.json','w'), ensure_ascii=False, indent=1)
import os
print('wrote data/graph.json', round(os.path.getsize('data/graph.json')/1024,1),'KB |',
      'data/workbook.json', round(os.path.getsize('data/workbook.json')/1024),'KB')
print('sheets:',len(sheets),'| cells:',sum(len(s['cells']) for s in sheets),'| nodes:',len(NODES),'edges:',len(EDGES))
