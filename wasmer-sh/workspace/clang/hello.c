#include <stdio.h>

int main(int argc, char *argv[]) {
    const char *name = argc > 1 ? argv[1] : "Wasmer";
    printf("Hello, %s!\n", name);
    printf("This C program was compiled to WebAssembly and run locally.\n");
    return 0;
}
