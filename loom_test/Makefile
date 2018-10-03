CURRENT_DIRECTORY = $(shell pwd)
GO_ETHEREUM_DEP = $(GOPATH)/src/github.com/ethereum/go-ethereum



.PHONY: all clean test lint deps demos abigen contracts

demos:
	go build -tags "evm" -o plasmacash_tester src/cmd/demo/main.go
	go build -tags "evm" -o plasmacash_challenge_after_tester src/cmd/challenge_after_demo/main.go
	go build -tags "evm" -o plasmacash_challenge_between_tester src/cmd/challenge_between_demo/main.go
	go build -tags "evm" -o plasmacash_challenge_before_tester src/cmd/challenge_before_demo/main.go
	go build -tags "evm" -o plasmacash_respond_challenge_before_tester src/cmd/respond_challenge_before_demo/main.go

contracts: contracts/hostileoperator.1.0.0

contracts/hostileoperator.1.0.0:
	go build -tags "evm" -o $@ src/hostile_operator/plugin/hostile_operator_plugin.go

test: 
	go test -tags "evm" ./...

lint:
	golint ./...

abigen:
	go build github.com/ethereum/go-ethereum/cmd/abigen
	cat ../server/build/contracts/RootChain.json | jq '.abi' > rootchain_abi.json
	./abigen --abi rootchain_abi.json  --pkg ethcontract --type RootChain --out src/ethcontract/root_chain.go 
	cat ../server/build/contracts/CryptoCards.json | jq '.abi' > cryptocards_abi.json
	./abigen --abi cryptocards_abi.json  --pkg ethcontract --type Cards --out src/ethcontract/cards.go
	
deps:
	go get \
		github.com/gogo/protobuf/jsonpb \
		github.com/gogo/protobuf/proto \
		github.com/spf13/cobra \
		github.com/spf13/viper \
		github.com/loomnetwork/go-loom \
		github.com/pkg/errors \
		github.com/go-kit/kit/log \
		github.com/ethereum/go-ethereum \
		github.com/gorilla/mux \
		github.com/inconshreveable/mousetrap \
		gopkg.in/check.v1 \
		github.com/stretchr/testify \
		github.com/grpc-ecosystem/go-grpc-prometheus \
		github.com/hashicorp/go-plugin \
		github.com/prometheus/client_golang/prometheus \
		github.com/loomnetwork/mamamerkle \
		github.com/miguelmota/go-solidity-sha3
	cd $(GO_ETHEREUM_DEP) && git checkout 477eb0

clean:
	go clean
	rm -f \
		contracts/hostileoperator.1.0.0 \
		src/types/types.pb.go \
		testdata/test.pb.go