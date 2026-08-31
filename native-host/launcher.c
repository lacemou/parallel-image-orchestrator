#include <stdio.h>
#include <unistd.h>

#ifndef NODE_PATH
#error "NODE_PATH must be supplied by the installer"
#endif

#ifndef HOST_PATH
#error "HOST_PATH must be supplied by the installer"
#endif

int main(void) {
  char *const argv[] = { "parallel-image-native-host", HOST_PATH, NULL };
  execv(NODE_PATH, argv);
  perror("Unable to start Node native host");
  return 127;
}
