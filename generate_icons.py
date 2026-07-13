#!/usr/bin/env python3
"""生成 TRS 扩展的 PNG 图标 (16x16, 48x48, 128x128)"""
import struct
import zlib
import os

def create_png(width, height, pixels):
    """创建 PNG 文件，pixels 为 RGBA 字节列表 (length = width*height*4)"""
    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)
        return struct.pack('>I', len(data)) + chunk + crc

    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr = make_chunk(b'IHDR', ihdr_data)

    # IDAT chunk - raw pixel data with filter byte per row
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter: None
        row_start = y * width * 4
        raw_data += bytes(pixels[row_start:row_start + width * 4])

    compressed = zlib.compress(raw_data)
    idat = make_chunk(b'IDAT', compressed)

    # IEND chunk
    iend = make_chunk(b'IEND', b'')

    return signature + ihdr + idat + iend


def make_icon(size):
    """生成一个带 'T' 字母的圆角方形图标"""
    pixels = []
    cx, cy = size / 2, size / 2
    r = size * 0.42  # 圆形半径

    # 颜色定义
    bg_color = (74, 111, 165, 255)     # #4a6fa5 蓝色主色
    letter_color = (255, 255, 255, 255)  # 白色字母
    transparent = (0, 0, 0, 0)

    for y in range(size):
        for x in range(size):
            # 计算到中心的距离
            dx, dy = x - cx + 0.5, y - cy + 0.5
            dist = (dx*dx + dy*dy) ** 0.5

            if dist <= r:
                # 在圆形内部 - 判断是否为字母 "T" 的笔画
                # T 字母: 顶部横线 + 中间竖线
                letter_half_w = size * 0.22
                letter_thick = max(2, size * 0.12)
                top_y = cy - r * 0.55
                bottom_y = cy + r * 0.55
                bar_top = top_y
                bar_bottom = top_y + letter_thick

                # 竖线
                in_vertical = abs(dx) < letter_thick / 2 and top_y <= dy <= bottom_y
                # 横线（顶部）
                in_horizontal = abs(dy - top_y) < letter_thick / 2 and abs(dx) < letter_half_w

                if in_vertical or in_horizontal:
                    pixels.extend(letter_color)
                else:
                    pixels.extend(bg_color)
            else:
                # 圆角处理：4个角的弧形
                corner_r = size * 0.18
                in_corner = False
                for sx, sy in [(-1, -1), (1, -1), (-1, 1), (1, 1)]:
                    corner_cx = sx * (size/2 - corner_r)
                    corner_cy = sy * (size/2 - corner_r)
                    cdx = x - (size/2 + corner_cx)
                    cdy = y - (size/2 + corner_cy)
                    if (cdx*cdx + cdy*cdy) ** 0.5 <= corner_r:
                        in_corner = True
                        break

                # 在圆角方形内
                margin = corner_r
                in_rect = (margin <= x < size - margin) and (0 <= y < size)
                in_rect = in_rect or ((0 <= y < margin or size - margin <= y < size) and (margin <= x < size - margin))
                in_rect = in_rect or in_corner

                if in_rect:
                    pixels.extend(bg_color)
                else:
                    pixels.extend(transparent)

    return pixels


def main():
    icons_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    for size in [16, 48, 128]:
        pixels = make_icon(size)
        png_data = create_png(size, size, pixels)
        filepath = os.path.join(icons_dir, f'icon{size}.png')
        with open(filepath, 'wb') as f:
            f.write(png_data)
        print(f'Created {filepath} ({size}x{size})')

    print('All icons generated!')

if __name__ == '__main__':
    main()
