# Generates clean, on-brand representative UI mockups of Reality CRM key screens.
# These are illustrative wireframe-style renders (not live screenshots).
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(OUT, exist_ok=True)

# ── palette (Indigo theme) ──
BRAND600=(79,70,229); BRAND700=(67,56,202); BRAND50=(238,242,255); BRAND100=(224,231,255)
WHITE=(255,255,255); BG=(248,250,252); CARD=(255,255,255)
LINE=(226,232,240); INK=(30,41,59); MUT=(100,116,139); FAINT=(148,163,184)
EMER=(5,150,105); EMER_BG=(209,250,229); AMBER=(180,83,9); AMBER_BG=(254,243,199)
ROSE=(225,29,72); ROSE_BG=(255,228,230); SKY=(3,105,161); SKY_BG=(224,242,254)
VIOLET=(109,40,217); VIOLET_BG=(237,233,254)

def font(sz, bold=False):
    paths = [r"C:\Windows\Fonts\arialbd.ttf"] if bold else [r"C:\Windows\Fonts\arial.ttf"]
    for p in paths:
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def text(d, xy, s, fnt, fill=INK):
    d.text(xy, s, font=fnt, fill=fill)

def chip(d, x, y, label, fg, bg):
    f=font(11, True); w=d.textlength(label, font=f)
    rrect(d,(x,y,x+w+18,y+20),10,fill=bg)
    text(d,(x+9,y+4),label,f,fg)
    return w+18

W,H=1280,800

# ───────────────────────── Sidebar + topbar (shared) ─────────────────────────
def shell(d, active="Dashboard", title="Dashboard"):
    SBW=232
    d.rectangle((0,0,SBW,H),fill=WHITE); d.line((SBW,0,SBW,H),fill=LINE)
    # logo
    rrect(d,(20,18,52,50),9,fill=BRAND600); text(d,(30,24),"R",font(18,True),WHITE)
    text(d,(62,26),"Reality CRM",font(15,True),INK)
    nav=["Dashboard","Campaigns","Leads","Accounts","Opportunities","Site Visits",
         "Inventory","Bookings","Demand & Receipts","Quotations","Reports","Settings"]
    y=78
    for n in nav:
        if n==active:
            rrect(d,(12,y-6,SBW-12,y+22),8,fill=BRAND50)
            text(d,(40,y),n,font(13,True),BRAND700)
        else:
            text(d,(40,y),n,font(13),MUT)
        d.ellipse((20,y+2,32,y+14),outline=FAINT if n!=active else BRAND600,width=2)
        y+=37
    # top bar
    d.rectangle((SBW,0,W,56),fill=WHITE); d.line((SBW,56,W,56),fill=LINE)
    rrect(d,(SBW+24,14,SBW+360,42),8,outline=LINE,width=1,fill=BG)
    text(d,(SBW+40,21),"Search leads, accounts, units, bookings...",font(12),FAINT)
    d.ellipse((W-120,16,W-100,36),outline=MUT,width=2)             # palette/theme
    d.ellipse((W-86,16,W-66,36),outline=MUT,width=2)               # bell
    rrect(d,(W-52,14,W-24,42),14,fill=BRAND100); text(d,(W-44,20),"SA",font(12,True),BRAND700)
    return SBW

# ───────────────────────── 1. LOGIN ─────────────────────────
def login():
    img=Image.new("RGB",(W,H),WHITE); d=ImageDraw.Draw(img)
    PW=560
    # brand panel with subtle vertical gradient
    for i in range(H):
        t=i/H; c=(int(67+ (40)*t), int(56+(30)*t), int(202-(40)*t))
        d.line((0,i,PW,i),fill=c)
    # floor-plan grid motif
    for gx in range(80,PW-40,70): d.line((gx,360,gx,640),fill=(255,255,255,30),width=1)
    for gy in range(360,640,55): d.line((80,gy,PW-60,gy),fill=(120,110,210))
    d.rectangle((80,360,PW-60,640),outline=(150,140,225),width=2)
    d.ellipse((300,470,330,500),outline=WHITE,width=3)
    rrect(d,(60,70,104,114),11,fill=WHITE); text(d,(74,78),"R",font(22,True),BRAND600)
    text(d,(118,82),"REALITY CRM",font(16,True),WHITE)
    text(d,(60,150),"Every booking starts",font(40,True),WHITE)
    text(d,(60,196),"on this floor plan.",font(40,True),(210,205,250))
    text(d,(60,260),"Campaigns, leads, site visits and bookings —",font(14),(205,200,245))
    text(d,(60,282),"tracked unit by unit, across every tower.",font(14),(205,200,245))
    text(d,(80,646),"TOWER B  ·  FLOOR 09  ·  UNIT 904",font(11,True),(190,185,235))
    # form
    cx=PW+80
    text(d,(cx,150),"Welcome back",font(26,True),INK)
    text(d,(cx,188),"Sign in to access your workspace",font(13),MUT)
    for lbl,val,y in [("EMAIL ADDRESS","admin@realitycrm.com",240),("PASSWORD","••••••••••",316)]:
        text(d,(cx,y),lbl,font(11,True),MUT)
        rrect(d,(cx,y+22,W-80,y+58),9,outline=LINE,width=1,fill=WHITE)
        text(d,(cx+14,y+31),val,font(13),INK)
    rrect(d,(cx,400,W-80,442),9,fill=BRAND600);
    tw=d.textlength("Sign in",font=font(14,True)); text(d,(cx+((W-80-cx)-tw)/2,412),"Sign in",font(14,True),WHITE)
    text(d,(cx,470),"DEMO WORKSPACE · PASS Passw0rd!",font(11,True),FAINT)
    for i,(role) in enumerate(["Super Admin","CRM Admin","Sales Agent","Channel Partner"]):
        yy=500+i*40; rrect(d,(cx,yy,W-80,yy+32),8,outline=LINE,width=1,fill=BG)
        text(d,(cx+14,yy+8),role,font(12,True),INK); text(d,(cx+150,yy+8),"  one-click sign in",font(11),MUT)
    img.save(os.path.join(OUT,"01-login.png")); print("login ok")

# ───────────────────────── 2. DASHBOARD ─────────────────────────
def dashboard():
    img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img)
    sb=shell(d,"Dashboard")
    x0=sb+24; y=80
    text(d,(x0,y),"Welcome, System Admin",font(22,True),INK)
    text(d,(x0,y+32),"Here's what's happening across your projects today.",font(13),MUT)
    # KPI cards
    kpis=[("Open Leads","128",EMER,"+12 this week"),("Site Visits","34",AMBER,"6 today"),
          ("Bookings (MTD)","19",SKY,"₹42.6 Cr value"),("Collections","₹8.9 Cr",VIOLET,"82% of demand")]
    cw=(W-x0-24-3*16)//4
    for i,(lbl,val,col,sub) in enumerate(kpis):
        cx=x0+i*(cw+16); cy=y+70
        rrect(d,(cx,cy,cx+cw,cy+108),12,fill=CARD,outline=LINE,width=1)
        rrect(d,(cx+16,cy+16,cx+40,cy+40),7,fill=tuple(min(255,c+170) for c in col))
        text(d,(cx+16,cy+50),val,font(24,True),INK)
        text(d,(cx+16,cy+82),lbl,font(12,True),MUT)
        text(d,(cx+16,cy+98)[0:2] if False else (cx+16,cy+98-14),"",font(10),col)
    # big cards
    by=y+200
    rrect(d,(x0,by,x0+ (W-x0-24)*0.62, by+330),12,fill=CARD,outline=LINE,width=1)
    text(d,(x0+18,by+16),"RECENT LEAD ACTIVITY",font(12,True),FAINT)
    rows=[("Anita Desai","Skyline Greens · 3BHK · ₹1.4Cr","QUALIFIED",VIOLET,VIOLET_BG),
          ("Rahul Verma","Century Crest · 2BHK · ₹82L","CONTACTED",SKY,SKY_BG),
          ("Meena Iyer","Century Springs · 2BHK","NEW",SKY,SKY_BG),
          ("Kiran Rao","Century Crest · 3BHK · ₹2.3Cr","NEGOTIATION",AMBER,AMBER_BG),
          ("Pooja Nair","Skyline Greens · 4BHK","SITE VISIT",EMER,EMER_BG)]
    ry=by+44
    for nm,sub,st,fg,bg in rows:
        text(d,(x0+18,ry),nm,font(13,True),INK); text(d,(x0+18,ry+18),sub,font(11),MUT)
        chip(d,int(x0+(W-x0-24)*0.62)-150,ry+4,st,fg,bg)
        d.line((x0+18,ry+44,x0+(W-x0-24)*0.62-18,ry+44),fill=LINE); ry+=54
    # right column
    rx=x0+(W-x0-24)*0.62+16
    rrect(d,(rx,by,W-24,by+150),12,fill=CARD,outline=BRAND100,width=1)
    text(d,(rx+16,by+16),"PIPELINE VALUE",font(11,True),BRAND600)
    text(d,(rx+16,by+40),"₹126.4 Cr",font(26,True),INK)
    text(d,(rx+16,by+78),"Across 64 open opportunities",font(12),MUT)
    rrect(d,(rx+16,by+108,W-40,by+124),8,fill=BG)
    rrect(d,(rx+16,by+108,rx+16+ (W-40-rx-16)*0.62,by+124),8,fill=BRAND600)
    rrect(d,(rx,by+166,W-24,by+330),12,fill=CARD,outline=LINE,width=1)
    text(d,(rx+16,by+182),"UPCOMING SITE VISITS",font(11,True),FAINT)
    for i,(nm,when) in enumerate([("Anita Desai","Today 4:00 PM"),("Sched. — Kiran Rao","Tomorrow 11 AM"),("Pooja Nair","Fri 3:30 PM")]):
        yy=by+212+i*36; text(d,(rx+16,yy),nm,font(12,True),INK); text(d,(W-150,yy),when,font(11),MUT)
    img.save(os.path.join(OUT,"02-dashboard.png")); print("dashboard ok")

# ───────────────────────── 3. LEADS KANBAN ─────────────────────────
def leads():
    img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img)
    sb=shell(d,"Leads")
    x0=sb+24; y=78
    text(d,(x0,y),"Leads",font(22,True),INK)
    text(d,(x0,y+32),"Track and progress every prospect through your pipeline",font(13),MUT)
    # toggle + add
    rrect(d,(W-360,y+2,W-232,y+34),8,outline=LINE,fill=WHITE,width=1)
    rrect(d,(W-358,y+4,W-300,y+32),6,fill=BRAND600); text(d,(W-352,y+10),"Kanban",font(11,True),WHITE)
    text(d,(W-292,y+10),"List",font(11,True),MUT)
    rrect(d,(W-150,y+2,W-24,y+34),8,fill=BRAND600); text(d,(W-132,y+10),"+ Add Lead",font(12,True),WHITE)
    cols=[("NEW",3,SKY),("CONTACTED",2,VIOLET),("QUALIFIED",2,VIOLET),("SITE VISIT",1,EMER),("NEGOTIATION",2,AMBER)]
    cards={
      "NEW":[("Meena Iyer","98765 12345","up to ₹1Cr",62),("Arvind Shah","99008 87766","₹1.5Cr+",55),("Pooja N.","90001 12233","—",48)],
      "CONTACTED":[("Rahul Verma","91234 56780","₹82L",58),("Deepa Nair","98123 09876","₹55L",44)],
      "QUALIFIED":[("Anita Desai","90011 22334","₹1.4Cr",78),("S. Reddy","98555 11122","₹2Cr",71)],
      "SITE VISIT":[("Pooja Nair","90001 12233","₹3.1Cr",80)],
      "NEGOTIATION":[("Kiran Rao","98712 34560","₹2.3Cr",84),("M. Desai","99887 00012","₹2.3Cr",69)],
    }
    cw=(W-x0-24-4*14)//5; cy=y+74
    for i,(name,cnt,col) in enumerate(cols):
        cx=x0+i*(cw+14)
        rrect(d,(cx,cy,cx+cw,H-24),12,fill=(241,245,249),outline=LINE,width=1)
        text(d,(cx+12,cy+12),name,font(10,True),MUT)
        rrect(d,(cx+cw-44,cy+8,cx+cw-12,cy+26),9,fill=WHITE); text(d,(cx+cw-36,cy+10),str(cnt),font(10,True),MUT)
        ky=cy+40
        for nm,ph,bud,score in cards[name]:
            rrect(d,(cx+10,ky,cx+cw-10,ky+78),10,fill=CARD,outline=LINE,width=1)
            text(d,(cx+20,ky+10),nm,font(12,True),INK)
            sc=EMER if score>=70 else (AMBER if score>=45 else ROSE)
            scbg=EMER_BG if score>=70 else (AMBER_BG if score>=45 else ROSE_BG)
            chip(d,cx+cw-58,ky+8,str(score),sc,scbg)
            text(d,(cx+20,ky+34),ph,font(11),MUT)
            text(d,(cx+20,ky+54),bud,font(11,True),BRAND700)
            ky+=88
    img.save(os.path.join(OUT,"03-leads-kanban.png")); print("leads ok")

login(); dashboard(); leads()
print("DONE ->", OUT)
