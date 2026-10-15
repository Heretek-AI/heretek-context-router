.PHONY: check accept install clean

check:
	bun install
	bun run check
	bun test

accept:
	bash scripts/accept/wave-*.sh

install:
	bun install

clean:
	rm -rf node_modules dist coverage .bun-cache
