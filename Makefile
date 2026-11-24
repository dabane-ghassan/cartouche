UUID    := cartouche@dabane-ghassan.github.io
VERSION := $(shell sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' extension/metadata.json)
DIST    := dist

.PHONY: all assets site install uninstall dist test lint clean

all: assets

# Redraw the logo and the social card from tools/make_brand.py.
assets:
	python3 tools/make_brand.py
	$(MAKE) site

# What the website needs from the app.
site:
	cp install.sh docs/install.sh
	touch docs/.nojekyll

install:
	sh install.sh

uninstall:
	sh install.sh --remove

# cartouche.tar.gz: everything install.sh needs (what the curl installer downloads).
# cartouche.shell-extension.zip: just the GNOME Shell part, for `gnome-extensions install`.
# $(UUID).zip: the same without compiled schemas, for extensions.gnome.org.
dist:
	rm -rf $(DIST) && mkdir -p $(DIST)/cartouche
	cp -R extension bin packaging install.sh LICENSE README.md $(DIST)/cartouche/
	rm -f $(DIST)/cartouche/extension/schemas/gschemas.compiled
	tar -C $(DIST) -czf $(DIST)/cartouche.tar.gz cartouche
	cd $(DIST)/cartouche/extension && zip -qr ../../$(UUID).zip .
	glib-compile-schemas $(DIST)/cartouche/extension/schemas
	cd $(DIST)/cartouche/extension && zip -qr ../../cartouche.shell-extension.zip .
	rm -rf $(DIST)/cartouche

# Static checks: JavaScript syntax, the settings schema, the shell scripts.
lint:
	for f in $$(find extension tests -name '*.js'); do node --input-type=module --check < $$f || exit 1; done
	glib-compile-schemas --strict --dry-run extension/schemas
	sh -n install.sh && sh -n bin/cartouche

# End-to-end tests in a headless GNOME Shell (see tests/README.md).
test:
	python3 tests/run.py
	python3 tests/boot.py

clean:
	rm -rf $(DIST) extension/schemas/gschemas.compiled tests/out tests/cover*.png
