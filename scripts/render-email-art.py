"""Render original LearnVerse vector artwork as Gmail-compatible inline PNGs.

Uses Pillow for development only; Lambda ships the resulting tiny PNG files.
SVG sources are generated from the same drawing operations for easy editing.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'server/mail-assets'
root.mkdir(parents=True, exist_ok=True)

def artwork(width, height, background, name):
    scale = 3
    image = Image.new('RGB', (width * scale, height * scale), background)
    draw = ImageDraw.Draw(image)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">', f'<rect width="{width}" height="{height}" fill="{background}"/>']
    def rect(box, fill, radius=0):
        x, y, right, bottom = box
        draw.rounded_rectangle(tuple(int(v * scale) for v in box), radius=radius * scale, fill=fill)
        svg.append(f'<rect x="{x}" y="{y}" width="{right-x}" height="{bottom-y}" rx="{radius}" fill="{fill}"/>')
    def circle(x, y, r, fill):
        draw.ellipse(((x-r)*scale,(y-r)*scale,(x+r)*scale,(y+r)*scale),fill=fill)
        svg.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}"/>')
    def line(points, fill, thickness=3):
        draw.line([(int(x*scale),int(y*scale)) for x,y in points],fill=fill,width=thickness*scale,joint='curve')
        svg.append(f'<polyline points="{" ".join(str(x)+","+str(y) for x,y in points)}" stroke="{fill}" stroke-width="{thickness}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>')
    def save():
        image.resize((width*2,height*2),Image.Resampling.LANCZOS).save(root / (name+'.png'),optimize=True)
        (root / (name+'.svg')).write_text('\n'.join(svg+['</svg>'])+'\n')
    return rect,circle,line,save

rect,circle,line,save=artwork(80,80,'#f4f6fb','logo')
rect((0,0,80,80),'#5c50d9',20)
rect((24,18,34,61),'#ffffff',2)
rect((24,51,58,61),'#ffffff',2)
save()

rect,circle,line,save=artwork(560,180,'#efedff','reset-hero')
circle(45,20,85,'#e8e3ff')
circle(525,167,92,'#e5e0fb')
circle(480,18,6,'#d7cff9')
circle(70,145,4,'#cbbff3')
rect((103,33,341,158),'#ddd6f4',12)
rect((97,27,335,152),'#ffffff',12)
rect((114,44,169,49),'#7763cf',2)
rect((114,56,194,59),'#ded9ec',1)
rect((114,76,132,94),'#e4f4ec',5)
line([(119,85),(123,89),(128,81)],'#469879',2)
rect((142,80,285,84),'#b7bed1',2)
rect((142,88,236,91),'#e5e8f0',1)
rect((114,108,132,126),'#eeebff',5)
circle(123,117,3,'#8069d6')
rect((142,112,298,116),'#c7c1df',2)
rect((142,120,254,123),'#e5e8f0',1)
circle(401,88,48,'#ddd4fa')
circle(401,83,45,'#6852c9')
rect((389,58,413,88),'#ffffff',10)
rect((394,63,408,85),'#6852c9',6)
rect((381,78,421,108),'#ffffff',7)
circle(401,91,3,'#6852c9')
rect((399,92,403,99),'#6852c9',1)
rect((325,132,439,155),'#ffffff',8)
circle(340,143,5,'#e4f4ec')
line([(337,143),(339,145),(343,140)],'#469879',1)
rect((352,140,426,144),'#b6aecf',2)
circle(352,20,3,'#bba8e8')
line([(466,68),(466,80)],'#b9a9e9',2)
line([(460,74),(472,74)],'#b9a9e9',2)
save()
print('Original brand logo and reset illustration rendered as SVG and inline PNG assets.')
