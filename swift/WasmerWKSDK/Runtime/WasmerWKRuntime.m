#import "WasmerWKRuntime.h"

@interface WasmerWKRuntimeBundle : NSObject
@end
@implementation WasmerWKRuntimeBundle
@end

NSURL *WasmerWKRuntimeWebURL(void) {
    return [[NSBundle bundleForClass:WasmerWKRuntimeBundle.class]
        URLForResource:@"Web" withExtension:nil];
}
