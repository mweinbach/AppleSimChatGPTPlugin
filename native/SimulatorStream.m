#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>
#import <IOSurface/IOSurface.h>
#import <ImageIO/ImageIO.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <poll.h>
#import <signal.h>
#import <unistd.h>
#import <fcntl.h>
#import <errno.h>

static volatile sig_atomic_t stopping = 0;
static int exitCode = 0;

static void stopSignal(int number) { stopping = 1; }

static void diagnostic(NSDictionary *event) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stderr);
    fputc('\n', stderr);
    fflush(stderr);
}

static void fail(NSString *message) {
    diagnostic(@{@"event": @"error", @"message": message});
    exitCode = 1;
    stopping = 1;
}

static id objectMessage(id target, const char *selector) {
    return ((id(*)(id, SEL))objc_msgSend)(target, sel_registerName(selector));
}

static BOOL writeBytes(const void *bytes, size_t length) {
    const uint8_t *cursor = bytes;
    while (length && !stopping) {
        ssize_t written = write(STDOUT_FILENO, cursor, length);
        if (written > 0) { cursor += written; length -= written; continue; }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd descriptor = { STDOUT_FILENO, POLLOUT, 0 };
            if (poll(&descriptor, 1, 100) >= 0) continue;
            if (errno == EINTR) continue;
        }
        stopping = 1;
        return NO;
    }
    return length == 0;
}

static NSString *developerDirectory(void) {
    NSString *configured = NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"];
    if (configured.length) return configured;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
    task.arguments = @[@"-p"];
    NSPipe *output = [NSPipe pipe];
    task.standardOutput = output;
    task.standardError = [NSPipe pipe];
    if (![task launchAndReturnError:nil]) return nil;
    [task waitUntilExit];
    if (task.terminationStatus) return nil;
    NSString *selected = [[NSString alloc] initWithData:[output.fileHandleForReading readDataToEndOfFile] encoding:NSUTF8StringEncoding];
    return [selected stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

@class SimulatorStream;
static void compressedFrame(void *context, void *sourceContext, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample);

@interface SimulatorStream : NSObject {
    id serviceContext;
    id device;
    id deviceIO;
    id screen;
    NSUUID *registration;
    dispatch_queue_t queue;
    dispatch_source_t timer;
    dispatch_semaphore_t encoderPermit;
    CVPixelBufferRef latestBuffer;
    VTCompressionSessionRef compression;
    CIContext *imageContext;
    CGColorSpaceRef colorSpace;
    NSInteger maxDimension;
    uint32_t orientation;
    size_t encodedWidth;
    size_t encodedHeight;
    size_t sourceWidth;
    size_t sourceHeight;
    uint32_t encodedOrientation;
    BOOL hardwareAccelerated;
    CMVideoCodecType codecType;
    NSString *codec;
    CFAbsoluteTime startedAt;
    uint64_t submittedFrames;
    uint64_t emittedFrames;
}
- (BOOL)startWithUDID:(NSString *)udid developerDirectory:(NSString *)developer maxDimension:(NSInteger)maximum codecType:(CMVideoCodecType)type;
- (void)emitSample:(CMSampleBufferRef)sample status:(OSStatus)status;
- (void)stop;
@end

@implementation SimulatorStream

- (BOOL)startWithUDID:(NSString *)udid developerDirectory:(NSString *)developer maxDimension:(NSInteger)maximum codecType:(CMVideoCodecType)type {
    codecType = type;
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW | RTLD_GLOBAL)) {
        fail([NSString stringWithFormat:@"Cannot load CoreSimulator: %s", dlerror()]);
        return NO;
    }
    NSError *error = nil;
    Class contextClass = NSClassFromString(@"SimServiceContext");
    serviceContext = ((id(*)(id, SEL, id, long long, NSError **))objc_msgSend)([contextClass alloc], sel_registerName("initWithDeveloperDir:connectionType:error:"), developer, 0, &error);
    if (!serviceContext) { fail(error.localizedDescription ?: @"Cannot create CoreSimulator service context."); return NO; }
    id deviceSet = ((id(*)(id, SEL, NSError **))objc_msgSend)(serviceContext, sel_registerName("defaultDeviceSetWithError:"), &error);
    if (!deviceSet) { fail(error.localizedDescription ?: @"Cannot read simulator device set."); return NO; }
    for (id candidate in objectMessage(deviceSet, "devices")) {
        NSUUID *identifier = objectMessage(candidate, "UDID");
        if ([identifier.UUIDString caseInsensitiveCompare:udid] == NSOrderedSame) { device = candidate; break; }
    }
    if (!device) { fail([NSString stringWithFormat:@"Simulator %@ is unavailable.", udid]); return NO; }
    if (![objectMessage(device, "stateString") isEqualToString:@"Booted"]) { fail(@"Boot the simulator before starting its live display."); return NO; }
    deviceIO = objectMessage(device, "io");
    uint32_t selectedID = UINT32_MAX;
    for (id port in objectMessage(deviceIO, "ioPorts")) {
        id descriptor = objectMessage(port, "descriptor");
        if (![descriptor respondsToSelector:sel_registerName("screenProperties")]) continue;
        id properties = objectMessage(descriptor, "screenProperties");
        uint32_t identifier = ((uint32_t(*)(id, SEL))objc_msgSend)(properties, sel_registerName("screenID"));
        if (identifier > 0 && identifier < selectedID) { screen = descriptor; selectedID = identifier; }
    }
    if (!screen || ![screen respondsToSelector:sel_registerName("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")]) {
        fail(@"CoreSimulator did not expose a live primary screen."); return NO;
    }
    maxDimension = maximum;
    orientation = 1;
    imageContext = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
    colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    queue = dispatch_queue_create("apple-device-hub.simulator-video", DISPATCH_QUEUE_SERIAL);
    encoderPermit = dispatch_semaphore_create(2);
    registration = [NSUUID UUID];
    startedAt = CFAbsoluteTimeGetCurrent();
    __weak SimulatorStream *weakSelf = self;
    ((void(*)(id, SEL, id, id, id, id, id))objc_msgSend)(screen, sel_registerName("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"), registration, queue,
        ^{},
        ^(id surface, id maskedSurface) { [weakSelf receiveSurface:(__bridge IOSurfaceRef)surface]; },
        ^(id properties) { [weakSelf receiveProperties:properties]; });
    dispatch_sync(queue, ^{ [self receiveProperties:objectMessage(self->screen, "screenProperties")]; });
    timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, NSEC_PER_SEC / 30, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(timer, ^{ @autoreleasepool { [weakSelf encodeLatestFrame]; } });
    dispatch_resume(timer);
    diagnostic(@{@"event": @"attached", @"udid": udid, @"screenID": @(selectedID), @"fps": @30, @"format": codecType == kCMVideoCodecType_HEVC ? @"hevc-annex-b" : @"h264-annex-b", @"framing": @"uint32be-length"});
    return YES;
}

- (void)receiveProperties:(id)properties {
    if ([properties respondsToSelector:sel_registerName("uiOrientation")]) orientation = ((uint32_t(*)(id, SEL))objc_msgSend)(properties, sel_registerName("uiOrientation"));
}

- (void)receiveSurface:(IOSurfaceRef)surface {
    if (latestBuffer) { CVPixelBufferRelease(latestBuffer); latestBuffer = nil; }
    if (!surface || stopping) return;
    OSStatus status = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, (__bridge CFDictionaryRef)@{ (id)kCVPixelBufferMetalCompatibilityKey: @YES }, &latestBuffer);
    if (status != kCVReturnSuccess) fail([NSString stringWithFormat:@"Cannot bind simulator IOSurface (%d).", status]);
}

- (BOOL)configureEncoderWithWidth:(size_t)width height:(size_t)height {
    if (compression) { VTCompressionSessionCompleteFrames(compression, kCMTimeInvalid); VTCompressionSessionInvalidate(compression); CFRelease(compression); compression = nil; }
    encodedWidth = width;
    encodedHeight = height;
    codec = nil;
    BOOL hevc = codecType == kCMVideoCodecType_HEVC;
    NSDictionary *specification = @{ (id)(hevc ? kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder : kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder): @YES };
    NSDictionary *attributes = @{ (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferWidthKey: @(width), (id)kCVPixelBufferHeightKey: @(height), (id)kCVPixelBufferIOSurfacePropertiesKey: @{}, (id)kCVPixelBufferMetalCompatibilityKey: @YES };
    OSStatus status = VTCompressionSessionCreate(kCFAllocatorDefault, (int32_t)width, (int32_t)height, hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264, (__bridge CFDictionaryRef)specification, (__bridge CFDictionaryRef)attributes, nil, compressedFrame, (__bridge void *)self, &compression);
    if (status) { fail([NSString stringWithFormat:@"Cannot create %@ encoder (%d).", hevc ? @"hardware HEVC" : @"H.264", status]); return NO; }
    NSDictionary *properties = @{ (id)kVTCompressionPropertyKey_RealTime: @YES, (id)kVTCompressionPropertyKey_AllowFrameReordering: @NO, (id)kVTCompressionPropertyKey_ProfileLevel: (id)(hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_Baseline_AutoLevel), (id)kVTCompressionPropertyKey_ExpectedFrameRate: @30, (id)kVTCompressionPropertyKey_MaxKeyFrameInterval: @30, (id)kVTCompressionPropertyKey_MaxFrameDelayCount: @1, (id)kVTCompressionPropertyKey_AverageBitRate: @(hevc ? MAX(width * height * 1.8, 1200000) : MAX(width * height * 3, 2000000)) };
    status = VTSessionSetProperties(compression, (__bridge CFDictionaryRef)properties);
    if (!status) status = VTCompressionSessionPrepareToEncodeFrames(compression);
    if (status) { fail([NSString stringWithFormat:@"Cannot configure %@ encoder (%d).", hevc ? @"HEVC" : @"H.264", status]); return NO; }
    CFTypeRef accelerated = nil;
    hardwareAccelerated = VTSessionCopyProperty(compression, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, kCFAllocatorDefault, &accelerated) == noErr && accelerated == kCFBooleanTrue;
    if (accelerated) CFRelease(accelerated);
    encodedOrientation = orientation;
    return YES;
}

- (void)encodeLatestFrame {
    if (stopping) return;
    if (!latestBuffer) {
        if (CFAbsoluteTimeGetCurrent() - startedAt > 10) fail(@"Timed out waiting for a simulator IOSurface.");
        return;
    }
    if (dispatch_semaphore_wait(encoderPermit, DISPATCH_TIME_NOW)) return;
    CIImage *image = [CIImage imageWithCVPixelBuffer:latestBuffer];
    CGImagePropertyOrientation rotation = kCGImagePropertyOrientationUp;
    if (orientation == 2) rotation = kCGImagePropertyOrientationDown;
    else if (orientation == 3) rotation = kCGImagePropertyOrientationRight;
    else if (orientation == 4) rotation = kCGImagePropertyOrientationLeft;
    image = [image imageByApplyingCGOrientation:rotation];
    CGRect extent = image.extent;
    CGFloat scale = maxDimension > 0 ? MIN(1.0, (CGFloat)maxDimension / MAX(extent.size.width, extent.size.height)) : 1.0;
    size_t width = MAX(2, ((size_t)(extent.size.width * scale)) & ~(size_t)1);
    size_t height = MAX(2, ((size_t)(extent.size.height * scale)) & ~(size_t)1);
    if (!compression || encodedWidth != width || encodedHeight != height || encodedOrientation != orientation) {
        if (![self configureEncoderWithWidth:width height:height]) { dispatch_semaphore_signal(encoderPermit); return; }
    }
    sourceWidth = CVPixelBufferGetWidth(latestBuffer);
    sourceHeight = CVPixelBufferGetHeight(latestBuffer);
    CVPixelBufferRef ownedBuffer = nil;
    OSStatus status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, VTCompressionSessionGetPixelBufferPool(compression), &ownedBuffer);
    if (status) { dispatch_semaphore_signal(encoderPermit); fail([NSString stringWithFormat:@"Cannot allocate video frame (%d).", status]); return; }
    image = [image imageByApplyingTransform:CGAffineTransformMakeTranslation(-extent.origin.x, -extent.origin.y)];
    image = [image imageByApplyingTransform:CGAffineTransformMakeScale((CGFloat)width / extent.size.width, (CGFloat)height / extent.size.height)];
    [imageContext render:image toCVPixelBuffer:ownedBuffer bounds:CGRectMake(0, 0, width, height) colorSpace:colorSpace];
    NSDictionary *frameProperties = submittedFrames % 30 == 0 ? @{ (id)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES } : nil;
    CMTime time = CMTimeMake((int64_t)submittedFrames++, 30);
    status = VTCompressionSessionEncodeFrame(compression, ownedBuffer, time, CMTimeMake(1, 30), (__bridge CFDictionaryRef)frameProperties, nil, nil);
    CVPixelBufferRelease(ownedBuffer);
    if (status) { dispatch_semaphore_signal(encoderPermit); fail([NSString stringWithFormat:@"Cannot encode video frame (%d).", status]); }
}

- (void)emitSample:(CMSampleBufferRef)sample status:(OSStatus)status {
    // VideoToolbox may deliver callbacks off the capture queue. Keep each length
    // header and payload together when nonblocking stdout requires several writes.
    @synchronized (self) {
        @autoreleasepool {
            if (status || !sample || stopping) { if (status && !stopping) fail([NSString stringWithFormat:@"Video encoder failed (%d).", status]); dispatch_semaphore_signal(encoderPermit); return; }
            CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, NO);
            CFDictionaryRef attachment = attachments && CFArrayGetCount(attachments) ? CFArrayGetValueAtIndex(attachments, 0) : nil;
            BOOL keyframe = !attachment || CFDictionaryGetValue(attachment, kCMSampleAttachmentKey_NotSync) != kCFBooleanTrue;
            CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
            NSMutableData *packet = [NSMutableData data];
            const uint8_t startCode[] = { 0, 0, 0, 1 };
            int headerLength = 0;
            size_t parameterCount = 0;
            BOOL hevc = CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_HEVC;
            OSStatus parameterStatus = hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, 0, nil, nil, &parameterCount, &headerLength) : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nil, nil, &parameterCount, &headerLength);
            if (parameterStatus || (headerLength != 1 && headerLength != 2 && headerLength != 4)) {
                fail(@"Video frame has invalid codec parameters."); dispatch_semaphore_signal(encoderPermit); return;
            }
            if (keyframe) {
                for (size_t index = 0; index < parameterCount; index++) {
                    const uint8_t *parameter = nil;
                    size_t length = 0;
                    parameterStatus = hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, index, &parameter, &length, nil, &headerLength) : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, index, &parameter, &length, nil, &headerLength);
                    if (parameterStatus) { fail(@"Video frame has no codec parameters."); break; }
                    [packet appendBytes:startCode length:sizeof(startCode)];
                    [packet appendBytes:parameter length:length];
                    if (index == 0 && !codec && length >= 4) {
                        codec = hevc ? @"hevc" : [NSString stringWithFormat:@"avc1.%02X%02X%02X", parameter[1], parameter[2], parameter[3]];
                        diagnostic(@{@"event": @"configuration", @"width": @(encodedWidth), @"height": @(encodedHeight), @"sourceWidth": @(sourceWidth), @"sourceHeight": @(sourceHeight), @"orientation": @(encodedOrientation), @"hardwareAccelerated": @(hardwareAccelerated), @"fps": @30, @"codec": codec, @"format": hevc ? @"hevc-annex-b" : @"h264-annex-b"});
                    }
                }
            }
            CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
            size_t length = CMBlockBufferGetDataLength(block);
            NSMutableData *avcc = [NSMutableData dataWithLength:length];
            if (CMBlockBufferCopyDataBytes(block, 0, length, avcc.mutableBytes)) { fail(@"Cannot read encoded video frame."); dispatch_semaphore_signal(encoderPermit); return; }
            const uint8_t *bytes = avcc.bytes;
            size_t offset = 0;
            while (offset < length) {
                if ((size_t)headerLength > length - offset) { fail(@"Video frame has a truncated NAL header."); break; }
                uint32_t nalLength = 0;
                for (int index = 0; index < headerLength; index++) nalLength = (nalLength << 8) | bytes[offset + index];
                offset += headerLength;
                if (!nalLength || nalLength > length - offset) { fail(@"Video frame has invalid NAL framing."); break; }
                [packet appendBytes:startCode length:sizeof(startCode)];
                [packet appendBytes:bytes + offset length:nalLength];
                offset += nalLength;
            }
            if (!stopping && packet.length) {
                uint32_t recordLength = CFSwapInt32HostToBig((uint32_t)packet.length);
                if (writeBytes(&recordLength, sizeof(recordLength)) && writeBytes(packet.bytes, packet.length)) emittedFrames++;
            }
            dispatch_semaphore_signal(encoderPermit);
        }
    }
}

- (void)stop {
    stopping = 1;
    if (timer) { dispatch_source_cancel(timer); timer = nil; }
    if (screen && registration) ((void(*)(id, SEL, id))objc_msgSend)(screen, sel_registerName("unregisterScreenCallbacksWithUUID:"), registration);
    if (queue) dispatch_sync(queue, ^{
        if (self->compression) { VTCompressionSessionCompleteFrames(self->compression, kCMTimeInvalid); VTCompressionSessionInvalidate(self->compression); CFRelease(self->compression); self->compression = nil; }
        if (self->latestBuffer) { CVPixelBufferRelease(self->latestBuffer); self->latestBuffer = nil; }
    });
    if (colorSpace) { CGColorSpaceRelease(colorSpace); colorSpace = nil; }
    diagnostic(@{@"event": @"stopped", @"frames": @(emittedFrames)});
}

@end

static void compressedFrame(void *context, void *sourceContext, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    [(__bridge SimulatorStream *)context emitSample:sample status:status];
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc < 2) { fprintf(stderr, "Usage: simulator-stream <UDID> [--codec hevc|h264] [--developer-dir <path>] [--max-dimension <pixels>]\n"); return 2; }
        NSString *udid = @(argv[1]);
        NSString *developer = developerDirectory();
        NSInteger maximum = 0;
        CMVideoCodecType codecType = kCMVideoCodecType_H264;
        for (int index = 2; index < argc; index++) {
            NSString *argument = @(argv[index]);
            if ([argument isEqualToString:@"--developer-dir"] && index + 1 < argc) developer = @(argv[++index]);
            else if ([argument isEqualToString:@"--codec"] && index + 1 < argc) {
                NSString *name = @(argv[++index]);
                if ([name isEqualToString:@"hevc"]) codecType = kCMVideoCodecType_HEVC;
                else if (![name isEqualToString:@"h264"]) { fail(@"Codec must be hevc or h264."); return 2; }
            }
            else if ([argument isEqualToString:@"--max-dimension"] && index + 1 < argc) { maximum = [@(argv[++index]) integerValue]; if (maximum < 2) { fail(@"Maximum dimension must be at least 2 pixels."); return 2; } }
            else { fail([NSString stringWithFormat:@"Unknown or incomplete argument: %@", argument]); return 2; }
        }
        if (!developer.length) { fail(@"Select Xcode or pass --developer-dir before starting a live display."); return 1; }
        signal(SIGINT, stopSignal);
        signal(SIGTERM, stopSignal);
        signal(SIGPIPE, SIG_IGN);
        int outputFlags = fcntl(STDOUT_FILENO, F_GETFL);
        if (outputFlags < 0 || fcntl(STDOUT_FILENO, F_SETFL, outputFlags | O_NONBLOCK) < 0) {
            fail([NSString stringWithFormat:@"Cannot configure simulator video output: %s", strerror(errno)]); return 1;
        }
        SimulatorStream *stream = [SimulatorStream new];
        @try {
            if ([stream startWithUDID:udid developerDirectory:developer maxDimension:maximum codecType:codecType]) {
                while (!stopping) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
            }
            [stream stop];
        } @catch (NSException *exception) {
            fail([NSString stringWithFormat:@"CoreSimulator live display failed: %@", exception.reason]);
            [stream stop];
        }
        return exitCode;
    }
}
