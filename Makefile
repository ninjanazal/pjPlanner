.DEFAULT_GOAL := help
.PHONY: help run node env install dev-backend dev-frontend build build-mcp test up down redeploy logs restart ps clean nuke

# Node 22+ is required (better-sqlite3 segfaults on 20). `make node` installs a private copy in .tools/node
# when the system has none, and every target below finds it through this PATH.
NODE_VERSION := 22.14.0
NODE_DIR := $(CURDIR)/.tools/node
export PATH := $(NODE_DIR)/bin:$(PATH)

# $(shell) captures stdout, so test the tty on stderr instead.
ifneq ($(NO_COLOR),)
  C_TITLE :=
else ifeq ($(shell test -t 2 && echo y),y)
  C_TITLE := \033[1;35m
  C_SECT  := \033[1;33m
  C_CMD   := \033[36m
  C_DIM   := \033[2m
  C_WARN  := \033[31m
  C_RST   := \033[0m
endif

# Lines starting with "##@" become section headers; "target: ## text" become entries.
# "!" at the start of the text marks a destructive target.
help:
	@printf "\n$(C_TITLE)  pjPlanner$(C_RST) $(C_DIM)- module graph planner$(C_RST)\n"
	@printf "  $(C_DIM)usage:$(C_RST) make $(C_CMD)<target>$(C_RST)\n"
	@awk 'BEGIN{FS=":.*## "} \
	  /^##@/ {printf "\n$(C_SECT)  %s$(C_RST)\n", substr($$0,5)} \
	  /^[a-zA-Z_-]+:.*## / { d=$$2; c="$(C_RST)"; if (substr(d,1,1)=="!") {d=substr(d,2); c="$(C_WARN)"} \
	    printf "    $(C_CMD)%-14s$(C_RST) %s%s$(C_RST)\n", $$1, c, d }' $(MAKEFILE_LIST)
	@printf "\n"

##@ Setup
node: ## Install Node 22 locally in .tools/ if the system has none
	@if node -e 'process.exit(+(([a,b]) => a > 22 || (a === 22 && b >= 12))(process.versions.node.split(".").map(Number)) ? 0 : 1)' >/dev/null 2>&1; then \
	  echo "Node $$(node -v) and npm $$(npm -v) found"; \
	else \
	  os=$$(uname -s | tr A-Z a-z); arch=$$(uname -m); \
	  case "$$arch" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "Unsupported CPU: $$arch (install Node 22 manually)"; exit 1;; esac; \
	  case "$$os" in linux|darwin) ;; *) echo "Unsupported OS: $$os (install Node 22 manually)"; exit 1;; esac; \
	  name=node-v$(NODE_VERSION)-$$os-$$arch; ext=tar.xz; tf=-xJ; [ "$$os" = darwin ] && { ext=tar.gz; tf=-xz; }; \
	  echo "Downloading Node $(NODE_VERSION) ($$os-$$arch) into .tools/node"; \
	  rm -rf $(NODE_DIR) && mkdir -p $(NODE_DIR) && \
	  curl -fsSL https://nodejs.org/dist/v$(NODE_VERSION)/$$name.$$ext | tar $$tf --strip-components=1 -C $(NODE_DIR) && \
	  echo "Installed Node $$($(NODE_DIR)/bin/node -v)"; \
	fi

env: ## Create .env from .env.example if missing (port and write key)
	@test -f .env || { cp .env.example .env && echo "Created .env; edit WRITE_KEY"; }

install: node env ## Install backend and frontend dependencies
	cd backend && npm install
	cd frontend && npm install


##@ Development
dev-backend: ## Run backend in watch mode
	cd backend && npm run dev

dev-frontend: ## Run frontend Vite dev server
	cd frontend && npm run dev


##@ Build & test
build: ## Build backend and frontend
	cd backend && npm run build
	cd frontend && npm run build

build-mcp: node ## Build the MCP server and the downloadable bundle
	cd mcp && npm install && npm run build && npm run bundle

test: ## Run backend and frontend tests
	cd backend && npm test
	cd frontend && npm test


##@ Docker
run: up ## Start the app and print the URL
	@printf "\n  $(C_CMD)http://localhost:$(or $(shell sed -n "s/^PORT=//p" .env 2>/dev/null),3030)$(C_RST)\n\n"

up: env ## Build and start the app in Docker (detached)
	docker compose up --build -d

down: ## Stop containers (keeps data volume)
	docker compose down

redeploy: down up ## Stop, then rebuild and start again (down + up)

logs: ## Follow container logs
	docker compose logs -f

restart: ## Restart the app service
	docker compose restart app

ps: ## List running containers
	docker compose ps


##@ Cleanup
clean: ## Remove node_modules and dist (keeps data volume)
	rm -rf backend/node_modules backend/dist frontend/node_modules frontend/dist

nuke: ## !Stop containers and DELETE the data volume (asks first)
	@printf "This deletes all stored data. Type 'yes' to continue: " && read ans && [ "$$ans" = "yes" ] || { echo "Aborted."; exit 1; }
	docker compose down -v
