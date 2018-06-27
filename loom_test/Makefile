CURRENT_DIRECTORY = $(shell pwd)



.PHONY: all clean test lint deps cli oracle

cli:
	go build -o plasmascash_tester src/cmd/demo/main.go

oracle:
	go build -o plasma_orc src/cmd/oracle/main.go

test: 
	go test ./...

lint:
	golint ./...

abigen:
	cat ../server/build/contracts/RootChain.json | jq '.abi' > rootchain_abi.json
	abigen --abi rootchain_abi.json  --pkg ethcontract --type RootChain --out src/ethcontract/root_chain.go 
	cat ../server/build/contracts/CryptoCards.json | jq '.abi' > cryptocards_abi.json
	abigen --abi cryptocards_abi.json  --pkg ethcontract --type Cards --out src/ethcontract/cards.go
	
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
		github.com/stretchr/testify

clean:
	go clean
	rm -f \
		src/types/types.pb.go \
		testdata/test.pb.go \