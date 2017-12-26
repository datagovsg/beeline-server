printf "\n------------------------------------------------------\n\n"
printf "Running pre-commit hook...\n\n"

git fetch

src_dir='src/*.js'
diff_filenames=$(git diff --name-only --cached origin/master -- "$src_dir")

if [ -z "$diff_filenames" ]
then 
  printf "No file changes detected!\n"
else
  printf "Running prettier and eslint on the following JS files in this branch...\n"
  printf "%b\n" "$diff_filenames"
  printf "\n"

  prettier_diff=$(./node_modules/prettier/bin/prettier.js --list-different $diff_filenames)

  if [ -z "$prettier_diff" ]
  then
    printf "No changes after running prettier"
  else
    printf "Running prettier on the following files:\n"
    ./node_modules/prettier/bin/prettier.js --write $prettier_diff
  fi

  printf "\nRunning ESLint with --fix option... "

  # Detect if eslint can autofix
  ./node_modules/eslint/bin/eslint.js --fix $diff_filenames

  printf "Done!\n"
fi

printf "\nPre-commit hook completed\n"
printf "\n------------------------------------------------------\n\n"