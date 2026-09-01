#!/usr/bin/env python3
"""Build the multi-runtime E2B image used by the latency benchmark."""

from e2b import Template


ALIAS = "wasmer-sdk-runtime-benchmark"


def main() -> None:
    template = (
        Template()
        .from_debian_image("bookworm")
        .apt_install(
            ["python3", "nodejs", "php-cli", "postgresql"],
            no_install_recommends=True,
        )
        .run_cmd(
            "mkdir -p /opt/pgdata && "
            "chown postgres:postgres /opt/pgdata && "
            "runuser -u postgres -- sh -lc "
            "'$(pg_config --bindir)/initdb -D /opt/pgdata -A trust'",
            user="root",
        )
    )
    build = Template.build(
        template,
        alias=ALIAS,
        cpu_count=2,
        memory_mb=1024,
    )
    print(f"built {ALIAS} ({build.template_id})")


if __name__ == "__main__":
    main()
