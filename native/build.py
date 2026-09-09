"""Compile LibRaw and DNG SDK to browser WASM with Emscripten 6.0.9."""

import hashlib
import os
import re
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

NATIVE = Path(__file__).resolve().parent
PROJECT = NATIVE.parent
CACHE = Path(os.environ.get("RAW_WEBGPU_CACHE", PROJECT / ".cache/native")).resolve()
OUTPUT = PROJECT / "dist/libraw.js"


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def download(name, url, checksum):
    archive = CACHE / name
    if not archive.exists():
        urllib.request.urlretrieve(url, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError(f"Source checksum mismatch: {name}")
    return archive


def prepare_sources(root):
    raw_archive = download(
        "libraw.tar.gz",
        "https://www.libraw.org/data/LibRaw-0.22.2.tar.gz",
        "de86b035655accff8d4010f1a221fdf50d353cb7b1422ba26f14a0db92612cfa",
    )
    sdk_archive = download(
        "dng-sdk.zip",
        "https://download.adobe.com/pub/adobe/dng/dng_sdk_1_7_1_2724_20260908.zip",
        "740fbe95c69e09e9cd17654a5e4fef2d7021254b06fd2b8c5557b79a1496b50c",
    )
    raw = root / "LibRaw-0.22.2"
    sdk = root / "dng_sdk_1_7_1"
    if not raw.exists():
        with tarfile.open(raw_archive) as archive:
            archive.extractall(root, filter="data")
    if not sdk.exists():
        with zipfile.ZipFile(sdk_archive) as archive:
            archive.extractall(root)

    # SDK 1.7.1 omits its XMP feature guard in two JPEG XL metadata blocks.
    source = sdk / "dng_sdk/source/dng_jxl.cpp"
    if "#if qDNGUseXMP\n\n\t\tif (includeXMP" not in source.read_text():
        run("patch", "-d", sdk, "-p1", "-i", NATIVE / "dng-no-xmp.patch")
    return raw, sdk


def build_jpeg_xl(em, source, output):
    disabled = [
        "TOOLS",
        "JPEGLI",
        "JPEGLI_LIBJPEG",
        "DOXYGEN",
        "MANPAGES",
        "BENCHMARK",
        "EXAMPLES",
        "JNI",
        "SJPEG",
        "OPENEXR",
        "TCMALLOC",
        "WASM_THREADS",
        "TRANSCODE_JPEG",
    ]
    run(
        em / "emcmake",
        "cmake",
        "-S",
        source,
        "-B",
        output,
        "-DBUILD_SHARED_LIBS=OFF",
        "-DBUILD_TESTING=OFF",
        "-DCMAKE_BUILD_TYPE=Release",
        "-DJPEGXL_BUNDLE_LIBPNG=OFF",
        "-DJPEGXL_ENABLE_SKCMS=ON",
        *[f"-DJPEGXL_ENABLE_{name}=OFF" for name in disabled],
        "-DCMAKE_CXX_FLAGS=-Oz -flto -fwasm-exceptions -msimd128",
        "-DCMAKE_C_FLAGS=-Oz -flto -msimd128",
    )
    run(
        "cmake",
        "--build",
        output,
        "--parallel",
        "6",
        "--target",
        "jxl_dec",
        "jxl_threads",
    )


def compiler_flags(includes):
    return [
        "-Oz",
        "-flto",
        "-fwasm-exceptions",
        "-msimd128",
        "-fno-rtti",
        "-fvisibility=hidden",
        "-fwhole-program-vtables",
        "-fvirtual-function-elimination",
        "-std=c++17",
        "-w",
        "-DLIBRAW_NOTHREADS",
        "-DLIBRAW_NO_IOSTREAMS_DATASTREAM",
        "-DUSE_DNGSDK",
        "-DUSE_X3FTOOLS",
        "-DUSE_ZLIB",
        "--use-port=zlib",
        "--use-port=libjpeg",
        "-DqWeb=1",
        "-DqDNGUseXMP=0",
        "-DqDNGXMPFiles=0",
        "-DqDNGXMPDocOps=0",
        "-DqDNGThreadSafe=0",
        "-DqDNGSupportVC5=0",
        "-DqDNGUseLibJPEG=1",
        "-DqDNG64Bit=0",
        "-DqDNGLittleEndian=1",
        "-DqDNGValidate=0",
    ] + [f"-I{path}" for path in includes]


def build_libraries(em, root, raw, sdk, flags):
    manifest = (raw / "Makefile.am").read_text()
    manifest = manifest.split("lib_libraw_a_SOURCES =", 1)[1]
    manifest = manifest.split("lib_libraw_r_a_CXXFLAGS", 1)[0]
    sources = [raw / path for path in re.findall(r"src/[\w/]+\.cpp", manifest)]
    excluded = {"dng_validate", "dng_xmp", "dng_xmp_sdk", "dng_update_meta"}
    sources.extend(path for path in sdk.glob("*.cpp") if path.stem not in excluded)
    objects = root / "objects"
    objects.mkdir(exist_ok=True)

    def compile_source(source):
        target = objects / f"{source.stem}.o"
        if not target.exists():
            run(em / "em++", *flags, "-c", source, "-o", target)
        return target

    with ThreadPoolExecutor(max_workers=6) as pool:
        compiled = list(pool.map(compile_source, sources))
    library = root / "libraries.a"
    run(em / "emar", "rcs", library, *compiled)
    return library


def link_wasm(em, flags, library, jxl):
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    run(
        em / "em++",
        *flags,
        *sorted(NATIVE.glob("*.cpp")),
        library,
        *jxl.rglob("*.a"),
        "-o",
        OUTPUT,
        "-sMODULARIZE=1",
        "-sEXPORT_ES6=1",
        "-sENVIRONMENT=web,worker",
        "-sINCOMING_MODULE_JS_API=instantiateWasm",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sSTACK_SIZE=1048576",
        "-sMAXIMUM_MEMORY=2147483648",
        "-sFILESYSTEM=0",
        "-sEXPORTED_FUNCTIONS=_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,HEAPU32,HEAPF64,UTF8ToString",
        "-sASSERTIONS=0",
    )


def main():
    compiler = shutil.which("em++")
    if not compiler:
        raise RuntimeError("Activate Emscripten 6.0.9 before running build")
    version = subprocess.check_output([compiler, "--version"], text=True)
    if "6.0.9" not in version:
        raise RuntimeError("This build is pinned to Emscripten 6.0.9")

    recipe = hashlib.sha256(
        version.encode()
        + Path(__file__).read_bytes()
        + (NATIVE / "dng-no-xmp.patch").read_bytes()
    ).hexdigest()
    root = CACHE / recipe[:16]
    root.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(
        recipe.encode()
        + b"".join(
            path.read_bytes()
            for path in sorted(NATIVE.iterdir())
            if path.suffix in {".cpp", ".h"}
        )
    ).hexdigest()
    stamp = root / "output.sha256"
    if (
        OUTPUT.exists()
        and OUTPUT.with_suffix(".wasm").exists()
        and stamp.exists()
        and stamp.read_text() == fingerprint
    ):
        print("Native build is up to date.")
        return

    em = Path(compiler).resolve().parent
    raw, sdk_root = prepare_sources(root)
    sdk = sdk_root / "dng_sdk/source"
    jxl = sdk_root / "libjxl/libjxl"
    jxl_build = root / "jxl-build"
    build_jpeg_xl(em, jxl, jxl_build)
    flags = compiler_flags([raw, sdk, jxl / "lib/include", jxl_build / "lib/include"])
    library = build_libraries(em, root, raw, sdk, flags)
    link_wasm(em, flags, library, jxl_build)
    stamp.write_text(fingerprint)


if __name__ == "__main__":
    main()
