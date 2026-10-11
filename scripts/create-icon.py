from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / "resources"
image = Image.new("RGBA", (256, 256))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 248, 248), radius=60, fill="#356aef")
draw.polygon([(128, 57), (203, 98), (128, 140), (53, 98)], outline="white", width=11)
draw.line([(53, 132), (128, 174), (203, 132)], fill="white", width=11, joint="curve")
draw.line([(53, 167), (128, 209), (203, 167)], fill="white", width=11, joint="curve")
image.save(root / "app.png")
image.save(root / "app.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
