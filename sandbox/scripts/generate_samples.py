#!/usr/bin/env python3
"""Generate three sample files in the specified output directory."""
import sys
import os

def main():
    output_dir = sys.argv[1] if len(sys.argv) > 1 else "generated"
    os.makedirs(output_dir, exist_ok=True)

    files = {
        "sample_a.txt": "Sample content A",
        "sample_b.txt": "Sample content B",
        "sample_c.txt": "Sample content C",
    }

    for name, content in files.items():
        path = os.path.join(output_dir, name)
        with open(path, "w") as f:
            f.write(content)
        print(f"Created: {path}")

    print(f"Done. Generated {len(files)} files in {output_dir}/")

if __name__ == "__main__":
    main()
