import zipfile  
import xml.etree.ElementTree as ET  
z = zipfile.ZipFile('개인정보처리방침.hwpx')  
sections = [f for f in z.namelist() if f.startswith('Contents/section')]  
text = ''  
for sec in sections:  
    root = ET.fromstring(z.read(sec))  
    for p in root.iter('{http://www.hancom.co.kr/hwpml/2011/paragraph}t'):  
        if p.text: text += p.text + '\n'  
with open('extracted.txt', 'w', encoding='utf-8') as f: f.write(text)  
