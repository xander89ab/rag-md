import subprocess
from pathlib import Path


def clean_text(text: str) -> str:
    text = text.replace("\r", "")
    text = " ".join(text.split("\t"))
    return text.strip()


def extract_djvu_text(path: Path) -> str:
    result = subprocess.run(
        ["djvutxt", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode == 0 and result.stdout.strip():
        return clean_text(result.stdout)

    ppm_path = path.with_suffix(".ppm")
    txt_base = path.with_suffix("")

    subprocess.run(
        [
            "ddjvu",
            "-format=ppm",
            "-quality=90",
            str(path),
            str(ppm_path),
        ],
        check=True,
    )

    subprocess.run(
        [
            "tesseract",
            str(ppm_path),
            str(txt_base),
            "-l",
            "rus+eng",
        ],
        check=True,
    )

    return clean_text(
        txt_base.with_suffix(".txt").read_text(
            encoding="utf-8",
            errors="ignore",
        )
    )


def extract_pdf_text(path: Path) -> list[tuple[int, str]]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages: list[tuple[int, str]] = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append((page_number, clean_text(text)))

    total_text = "".join(text for _, text in pages)

    if len(total_text.strip()) < 200:
        return extract_pdf_ocr(path)

    return pages


def extract_pdf_ocr(path: Path) -> list[tuple[int, str]]:
    ocr_dir = path.parent / f"_ocr_{path.stem}"
    ocr_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [
            "pdftoppm",
            "-r",
            "300",
            "-png",
            str(path),
            str(ocr_dir / "page"),
        ],
        check=True,
    )

    pages: list[tuple[int, str]] = []

    for image in sorted(ocr_dir.glob("page-*.png")):
        page_number = int(image.stem.split("-")[-1])
        txt_base = image.with_suffix("")

        subprocess.run(
            [
                "tesseract",
                str(image),
                str(txt_base),
                "-l",
                "rus+eng",
            ],
            check=True,
        )

        text = txt_base.with_suffix(".txt").read_text(
            encoding="utf-8",
            errors="ignore",
        )

        pages.append((page_number, clean_text(text)))

    return pages


def extract_text(path: Path) -> str | list[tuple[int, str]]:
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        return extract_pdf_text(path)

    if suffix in {".djvu", ".djv"}:
        return extract_djvu_text(path)

    if suffix in {".txt", ".md"}:
        return clean_text(
            path.read_text(encoding="utf-8", errors="ignore")
        )

    raise ValueError(f"Неподдерживаемый формат файла: {suffix}")