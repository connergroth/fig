//
//  LocationSpoof.h
//  findmy-dylib
//
//  Global CLLocationManager override so that fmfd / Find My never sees
//  the Mac Mini's real location. Must be installed at dylib load time
//  BEFORE any share/poll call is made.
//

#import <Foundation/Foundation.h>

@interface LocationSpoof : NSObject
+ (void)installIfNeeded;
@end
