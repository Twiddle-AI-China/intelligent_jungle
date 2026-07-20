#!/usr/bin/env python3
from __future__ import annotations

import argparse
from copy import deepcopy
from pathlib import Path

import yaml


CLASSES = ("pad", "lead", "base", "pluck", "texture")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="configs/v2/base.yaml")
    parser.add_argument("--output", default="configs/v2/generated")
    parser.add_argument(
        "--top50-100k", action="store_true",
        help="materialize the formal Serum Top50, 100k Phase-1 training profile",
    )
    args = parser.parse_args()
    base = yaml.safe_load(Path(args.base).read_text(encoding="utf-8"))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    for class_name in CLASSES:
        for precision in ("safe_fallback", "fp16_candidate"):
            value = deepcopy(base)
            view = "top50" if args.top50_100k else ""
            manifest_root = "/data/midibrave-v2/manifests" + (f"/{view}" if view else "")
            cache_root = "/data/midibrave-v2/cache" + (f"/{view}" if view else "")
            value["data"]["manifest"] = f"{manifest_root}/{class_name}.jsonl"
            value["data"]["manifest_metadata"] = f"{manifest_root}/{class_name}.meta.json"
            value["data"]["cache_root"] = f"{cache_root}/{class_name}"
            value["data"]["class_name"] = class_name
            value["data"]["onset_crop_probability"] = 0.75 if class_name in {"pluck", "texture"} else 0.5
            if args.top50_100k:
                value["train"]["phase1_steps"] = 100000
                value["train"]["checkpoint_every"] = 0
                value["train"]["rolling_checkpoint_every"] = 1000
                value["train"]["checkpoint_updates"] = [
                    1000, *range(10000, 100001, 10000),
                ]
                value["train"]["run_name"] = (
                    f"{class_name}_clap_recon_top50_100k_{precision}")
            else:
                value["train"]["run_name"] = f"{class_name}_{precision}"
            candidate = precision == "fp16_candidate"
            value["model"]["decoder_fp32_tail"] = not candidate
            value["model"]["pqmf_dtype"] = "amp_fp16" if candidate else "fp32"
            if class_name == "texture":
                value["loss"]["self_spectral_flux"] = 0.2
                value["loss"]["cross_spectral_flux"] = 0.1
                value["loss"]["self_band_statistics"] = 0.2
                value["loss"]["cross_band_statistics"] = 0.1
            destination = output / f"{class_name}_{precision}.yaml"
            destination.write_text(
                yaml.safe_dump(value, sort_keys=False, allow_unicode=True), encoding="utf-8")


if __name__ == "__main__":
    main()
