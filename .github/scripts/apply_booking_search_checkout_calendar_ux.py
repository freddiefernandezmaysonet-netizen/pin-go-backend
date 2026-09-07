from pathlib import Path

path = Path("src/booking-search.preview.html")
text = path.read_text()

old = "ci.onchange=()=>{if(!ci.value){co.min=today;return}const n=new Date(ci.value+'T00:00:00Z');n.setUTCDate(n.getUTCDate()+1);co.min=n.toISOString().slice(0,10);if(co.value&&co.value<co.min)co.value=''};"
new = "ci.onchange=()=>{if(!ci.value){co.min=today;return}const n=new Date(ci.value+'T00:00:00Z');n.setUTCDate(n.getUTCDate()+1);const nextCheckout=n.toISOString().slice(0,10);co.min=nextCheckout;if(!co.value||co.value<co.min)co.value=nextCheckout};"

count = text.count(old)
if count != 1:
    raise SystemExit(f"Expected exactly one check-in anchor, found {count}")

text = text.replace(old, new, 1)
path.write_text(text)
