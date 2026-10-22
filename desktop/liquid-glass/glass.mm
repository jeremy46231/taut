// Native Liquid Glass for Taut Desktop (it finds NSGlassEffectView by name at runtime, so it builds with any recent SDK): hosts one NSGlassEffectView per page surface under a transparent Electron window
//
// setShapes(windowHandle, shapes) takes every surface at once and diffs by id.
//   shape = { id, x, y, w, h, path: number[], tint?: [r,g,b,a], clear?: boolean, above?: boolean }
// `above` puts the glass over the page, where it bends and highlights what Slack draws under it, and clicks pass through
// x, y, w, h are in points from the window content's top-left. `path` is in the
// surface's own coordinates (0,0 is its top-left) as a flat list of ops:
//   0 x y            move to
//   1 x y            line to
//   2 x1 y1 x2 y2 x y   cubic curve to
//   3                close
// so a surface can be any shape, not just a rounded rectangle.

#include <node_api.h>
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <map>
#include <vector>

static const void* kGlassViewsKey = &kGlassViewsKey;

// a plain view that is never hit, for glass that should only be looked at
@interface TautPassThroughView : NSView
@end
@implementation TautPassThroughView
- (NSView*)hitTest:(NSPoint)point {
  return nil;
}
@end

@interface TautGlassState : NSObject
@property(strong) NSMutableDictionary<NSNumber*, NSView*>* views;
@property(strong) NSView* container;
@property(strong) NSView* holder;
@property(strong) NSView* aboveContainer;
@property(strong) NSView* aboveHolder;
@property(strong) NSMutableDictionary<NSNumber*, NSNumber*>* modes;
@property(strong) NSView* shapedHolder;
@property(strong) NSView* shapedAboveHolder;
@end
@implementation TautGlassState
- (instancetype)init {
  if ((self = [super init])) _views = [NSMutableDictionary new];
  return self;
}
@end

// glass above the page must never take a click, so it gets a container that is invisible to hit testing
static Class PassThroughContainerClass(Class base) {
  static Class cls = nil;
  if (cls) return cls;
  cls = objc_allocateClassPair(base, "TautPassThroughGlassContainer", 0);
  if (!cls) return base;
  IMP imp = imp_implementationWithBlock(^NSView*(id self, NSPoint point) { return nil; });
  class_addMethod(cls, @selector(hitTest:), imp, "@@:{CGPoint=dd}");
  objc_registerClassPair(cls);
  return cls;
}

static void BuildLayer(NSView* content, Class containerClass, BOOL above, NSView** containerOut,
                       NSView** holderOut) {
  NSView* holder = [[NSView alloc] initWithFrame:content.bounds];
  holder.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  NSView* container = nil;
  if (containerClass) {
    Class cls = above ? PassThroughContainerClass(containerClass) : containerClass;
    container = [[cls alloc] initWithFrame:content.bounds];
    container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [container setValue:holder forKey:@"contentView"];
  }
  NSView* root = container ?: holder;
  [content addSubview:root positioned:above ? NSWindowAbove : NSWindowBelow relativeTo:nil];
  *containerOut = container;
  *holderOut = holder;
}

static napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static double NumberAt(napi_env env, napi_value array, uint32_t i) {
  napi_value item;
  double out = 0;
  if (napi_get_element(env, array, i, &item) == napi_ok)
    napi_get_value_double(env, item, &out);
  return out;
}

static napi_value Prop(napi_env env, napi_value object, const char* name) {
  napi_value out;
  if (napi_get_named_property(env, object, name, &out) != napi_ok) return nullptr;
  napi_valuetype type;
  napi_typeof(env, out, &type);
  return (type == napi_undefined || type == napi_null) ? nullptr : out;
}

static double NumProp(napi_env env, napi_value object, const char* name) {
  napi_value value = Prop(env, object, name);
  double out = 0;
  if (value) napi_get_value_double(env, value, &out);
  return out;
}

static bool BoolProp(napi_env env, napi_value object, const char* name) {
  napi_value value = Prop(env, object, name);
  bool out = false;
  if (value) napi_get_value_bool(env, value, &out);
  return out;
}

static NSView* ContentViewFromHandle(napi_env env, napi_value handle) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok ||
      length < sizeof(void*))
    return nil;
  return *reinterpret_cast<NSView* __strong*>(data);
}

static CGPathRef BuildPath(napi_env env, napi_value ops, CGFloat height) {
  uint32_t count = 0;
  napi_get_array_length(env, ops, &count);
  CGMutablePathRef path = CGPathCreateMutable();
  // the page's y runs down, AppKit's runs up
  CGAffineTransform flip = CGAffineTransformMake(1, 0, 0, -1, 0, height);
  uint32_t i = 0;
  while (i < count) {
    int op = (int)NumberAt(env, ops, i++);
    switch (op) {
      case 0:
        if (i + 2 > count) goto done;
        CGPathMoveToPoint(path, &flip, NumberAt(env, ops, i), NumberAt(env, ops, i + 1));
        i += 2;
        break;
      case 1:
        if (i + 2 > count) goto done;
        CGPathAddLineToPoint(path, &flip, NumberAt(env, ops, i), NumberAt(env, ops, i + 1));
        i += 2;
        break;
      case 2:
        if (i + 6 > count) goto done;
        CGPathAddCurveToPoint(path, &flip, NumberAt(env, ops, i), NumberAt(env, ops, i + 1),
                              NumberAt(env, ops, i + 2), NumberAt(env, ops, i + 3),
                              NumberAt(env, ops, i + 4), NumberAt(env, ops, i + 5));
        i += 6;
        break;
      case 3:
        CGPathCloseSubpath(path);
        break;
      default:
        goto done;
    }
  }
done:
  return path;
}

// makes the window see-through so the glass underneath is what shows where the page is transparent
static napi_value PrepareWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return Throw(env, "prepareWindow(handle)");
  NSView* content = ContentViewFromHandle(env, args[0]);
  if (!content || !content.window) return Throw(env, "no window for handle");
  NSWindow* window = content.window;
  window.opaque = NO;
  window.backgroundColor = NSColor.clearColor;
  return nullptr;
}

static napi_value SetShapes(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) return Throw(env, "setShapes(handle, shapes, options?)");
  napi_value options = argc > 2 ? args[2] : nullptr;
  double spacing = 24;
  BOOL animate = YES;
  BOOL partial = NO;
  if (options) {
    napi_value pv = Prop(env, options, "partial");
    if (pv) { bool b = false; napi_get_value_bool(env, pv, &b); partial = b; }
    napi_value v = Prop(env, options, "spacing");
    if (v) napi_get_value_double(env, v, &spacing);
    napi_value a = Prop(env, options, "animate");
    if (a) { bool b = true; napi_get_value_bool(env, a, &b); animate = b; }
  }
  Class glassClass = NSClassFromString(@"NSGlassEffectView");
  if (!glassClass) return Throw(env, "NSGlassEffectView needs macOS 26");

  NSView* content = ContentViewFromHandle(env, args[0]);
  if (!content) return Throw(env, "bad window handle");

  uint32_t count = 0;
  napi_get_array_length(env, args[1], &count);

  TautGlassState* state = objc_getAssociatedObject(content, kGlassViewsKey);
  if (!state) {
    state = [TautGlassState new];
    objc_setAssociatedObject(content, kGlassViewsKey, state, OBJC_ASSOCIATION_RETAIN);
  }

  // Slack sets its own window color whenever its theme changes
  if (content.window) {
    content.window.opaque = NO;
    content.window.backgroundColor = NSColor.clearColor;
  }

  // one glass container per layer, so neighbouring glass merges and morphs like system Liquid Glass
  Class containerClass = NSClassFromString(@"NSGlassEffectContainerView");
  if (!state.holder) {
    NSView *container, *holder;
    BuildLayer(content, containerClass, NO, &container, &holder);
    state.container = container;
    state.holder = holder;
  }
  if (!state.aboveHolder) {
    NSView *container, *holder;
    BuildLayer(content, containerClass, YES, &container, &holder);
    state.aboveContainer = container;
    state.aboveHolder = holder;
    state.modes = [NSMutableDictionary new];
  }
  // a glass container draws its members from their frames and ignores their shape masks, so pieces
  // with a custom shape live in plain views of their own, where the mask is honored
  if (!state.shapedHolder) {
    NSView* below = [[TautPassThroughView alloc] initWithFrame:content.bounds];
    below.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [content addSubview:below positioned:NSWindowBelow relativeTo:nil];
    state.shapedHolder = below;
    NSView* above = [[TautPassThroughView alloc] initWithFrame:content.bounds];
    above.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [content addSubview:above positioned:NSWindowAbove relativeTo:nil];
    state.shapedAboveHolder = above;
  }
  // Electron adds views of its own, so the layers over the page are put back on top each time
  NSView* aboveRoot = state.aboveContainer ?: state.aboveHolder;
  [content addSubview:aboveRoot positioned:NSWindowAbove relativeTo:nil];
  [content addSubview:state.shapedAboveHolder positioned:NSWindowAbove relativeTo:nil];
  [state.container setValue:@(spacing) forKey:@"spacing"];
  [state.aboveContainer setValue:@(spacing) forKey:@"spacing"];

  NSMutableSet<NSNumber*>* seen = [NSMutableSet new];
  CGFloat contentHeight = content.bounds.size.height;

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t n = 0; n < count; n++) {
    napi_value shape;
    napi_get_element(env, args[1], n, &shape);
    NSNumber* key = @((int)NumProp(env, shape, "id"));
    [seen addObject:key];

    CGFloat x = NumProp(env, shape, "x"), y = NumProp(env, shape, "y");
    CGFloat w = NumProp(env, shape, "w"), h = NumProp(env, shape, "h");
    if (w < 1 || h < 1) continue;
    NSRect frame = content.isFlipped ? NSMakeRect(x, y, w, h)
                                     : NSMakeRect(x, contentHeight - y - h, w, h);

    BOOL above = BoolProp(env, shape, "above");
    BOOL snap = BoolProp(env, shape, "snap");
    BOOL shaped = BoolProp(env, shape, "shaped");
    NSNumber* mode = @((above ? 1 : 0) | (shaped ? 2 : 0));
    NSView* glass = state.views[key];
    if (glass && ![state.modes[key] isEqual:mode]) {
      [glass removeFromSuperview];
      [state.views removeObjectForKey:key];
      glass = nil;
    }
    state.modes[key] = mode;
    if (!glass) {
      glass = [[glassClass alloc] initWithFrame:frame];
      glass.wantsLayer = YES;
      glass.alphaValue = 0;
      NSView* holder = shaped ? (above ? state.shapedAboveHolder : state.shapedHolder)
                              : (above ? state.aboveHolder : state.holder);
      [holder addSubview:glass];
      state.views[key] = glass;
      // only exists from macOS 27, where it makes the glass react to the pointer
      if ([glass respondsToSelector:NSSelectorFromString(@"setEffectIsInteractive:")])
        [glass setValue:@YES forKey:@"effectIsInteractive"];
      if (animate && !snap) {
        [NSAnimationContext runAnimationGroup:^(NSAnimationContext* ctx) {
          ctx.duration = 0.35;
          glass.animator.alphaValue = 1;
        }];
      } else {
        glass.alphaValue = 1;
      }
    } else if (animate && !snap && !NSEqualRects(glass.frame, frame)) {
      [NSAnimationContext runAnimationGroup:^(NSAnimationContext* ctx) {
        ctx.duration = 0.22;
        ctx.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.2 :0.9 :0.3 :1.0];
        glass.animator.frame = frame;
      }];
    } else {
      glass.frame = frame;
    }

    napi_value ops = Prop(env, shape, "path");
    if (shaped && ops) {
      CGPathRef path = BuildPath(env, ops, h);
      CAShapeLayer* mask = [CAShapeLayer layer];
      mask.path = path;
      mask.frame = CGRectMake(0, 0, w, h);
      glass.layer.mask = mask;
      CGPathRelease(path);
    } else {
      glass.layer.mask = nil;
      // inside a container the glass is a rounded rectangle, so its corners are what the page's element has
      napi_value radius = Prop(env, shape, "radius");
      if (radius) {
        double r = 0;
        napi_get_value_double(env, radius, &r);
        [glass setValue:@(r) forKey:@"cornerRadius"];
      }
    }

    napi_value tint = Prop(env, shape, "tint");
    NSColor* color = nil;
    if (tint) {
      color = [NSColor colorWithSRGBRed:NumberAt(env, tint, 0) / 255.0
                                  green:NumberAt(env, tint, 1) / 255.0
                                   blue:NumberAt(env, tint, 2) / 255.0
                                  alpha:NumberAt(env, tint, 3)];
    }
    // NSGlassEffectView is a macOS 26 class, so its properties are set by KVC
    [glass setValue:color forKey:@"tintColor"];
    [glass setValue:@(BoolProp(env, shape, "clear") ? 1 : 0) forKey:@"style"];
  }

  for (NSNumber* key in [state.views.allKeys copy]) {
    if (partial || [seen containsObject:key]) continue;
    NSView* gone = state.views[key];
    [state.views removeObjectForKey:key];
    [state.modes removeObjectForKey:key];
    if (!animate) {
      [gone removeFromSuperview];
      continue;
    }
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* ctx) {
      ctx.duration = 0.25;
      gone.animator.alphaValue = 0;
    } completionHandler:^{ [gone removeFromSuperview]; }];
  }
  [CATransaction commit];

  NSMutableString* report = [NSMutableString string];
  [report appendFormat:@"opaque=%d glass=%lu content=%@ subviews:", content.window.opaque,
          (unsigned long)state.views.count, NSStringFromRect(content.frame)];
  for (NSView* v in content.subviews)
    [report appendFormat:@" %@%@", NSStringFromClass(v.class), NSStringFromRect(v.frame)];
  napi_value out;
  napi_create_string_utf8(env, report.UTF8String, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "setShapes", NAPI_AUTO_LENGTH, SetShapes, nullptr, &fn);
  napi_set_named_property(env, exports, "setShapes", fn);
  napi_create_function(env, "prepareWindow", NAPI_AUTO_LENGTH, PrepareWindow, nullptr, &fn);
  napi_set_named_property(env, exports, "prepareWindow", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
