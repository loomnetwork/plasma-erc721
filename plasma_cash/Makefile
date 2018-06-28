test:
	pytest unit_test.py

lint:
	flake8 child_chain client contract_binds utils *.py --ignore=E203,W503 --exclude unit_test.py,config.py,dump_test_data.py

format:
	black --line-length 79 -S .
	isort -rc .
