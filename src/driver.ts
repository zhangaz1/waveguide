// Copyright 2019 Ryan Zeigler
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Either, fold as foldEither } from "fp-ts/lib/Either";
import { FunctionN, Lazy } from "fp-ts/lib/function";
import { Option } from "fp-ts/lib/Option";
import { Cause, Done, done, Exit, interrupt as interruptExit, raise } from "./exit";
import { RIO } from "./io";
import * as io from "./io";
import { defaultRuntime, Runtime } from "./runtime";
import { Completable, completable } from "./support/completable";
import { MutableStack, mutableStack } from "./support/mutable-stack";

// It turns out th is is used quite often
type UnkIO = RIO<unknown, unknown, unknown>

export type RegionFrameType = InterruptFrame | EnvironmentFrame
export type FrameType = Frame | FoldFrame | RegionFrameType;

interface Frame {
    readonly _tag: "frame";
    apply(u: unknown): UnkIO;
}

const makeFrame = (f: FunctionN<[unknown], UnkIO>): Frame => ({
    _tag: "frame",
    apply: f
});

interface FoldFrame {
    readonly _tag: "fold-frame";
    apply(u: unknown): UnkIO;
    recover(cause: Cause<unknown>): UnkIO;
}

const makeFoldFrame = (f: FunctionN<[unknown], UnkIO>,
    r: FunctionN<[Cause<unknown>], UnkIO>): FoldFrame => ({
    _tag: "fold-frame",
    apply: f,
    recover: r
});

interface InterruptFrame {
    readonly _tag: "interrupt-frame";
    apply(u: unknown): UnkIO;
    exitRegion(): void;
}

const makeInterruptFrame = (interruptStatus: MutableStack<boolean>): InterruptFrame => {
    return {
        _tag: "interrupt-frame",
        apply(u: unknown) {
            interruptStatus.pop();
            return io.pure(u);
        },
        exitRegion() {
            interruptStatus.pop();
        }
    };
};

interface EnvironmentFrame {
    readonly _tag: "environment-frame";
    apply(u: unknown): UnkIO;
    exitRegion(): void;
}

const makeEnvironmentFrame = (environmentStack: MutableStack<any>): EnvironmentFrame => { // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
        _tag: "environment-frame",
        apply(u: unknown) {
            environmentStack.pop();
            return io.pure(u)
        },
        exitRegion() {
            environmentStack.pop();
        }
    }
}

export interface Driver<R, E, A> {
    start(r: R, run: RIO<R, E, A>): void;
    interrupt(): void;
    onExit(f: FunctionN<[Exit<E, A>], void>): Lazy<void>;
    exit(): Option<Exit<E, A>>;
}

export function makeDriver<R, E, A>(runtime: Runtime = defaultRuntime): Driver<R, E, A> {
    let started = false;
    let interrupted = false;
    const result: Completable<Exit<E, A>> = completable();
    const frameStack: MutableStack<FrameType> = mutableStack();
    const interruptRegionStack: MutableStack<boolean> = mutableStack();
    const environmentStack: MutableStack<any> = mutableStack(); // eslint-disable-line @typescript-eslint/no-explicit-any
    let cancelAsync: Lazy<void> | undefined;


    function onExit(f: FunctionN<[Exit<E, A>], void>): Lazy<void> {
        return result.listen(f);
    }

    function exit(): Option<Exit<E, A>> {
        return result.value();
    }

    
    function isInterruptible(): boolean {
        const flag =  interruptRegionStack.peek();
        if (flag === undefined) {
            return true;
        }
        return flag;
    }

    function canRecover(cause: Cause<unknown>): boolean {
    // It is only possible to recovery from interrupts in an uninterruptible region
        if (cause._tag === "interrupt") {
            return !isInterruptible();
        }
        return true;
    }

    function handle(e: Cause<unknown>): RIO<unknown, unknown, unknown> | undefined {
        let frame = frameStack.pop();
        while (frame) {
            if (frame._tag === "fold-frame" && canRecover(e)) {
                return frame.recover(e);
            }
            // We need to make sure we leave an interrupt region or environment provision region while unwinding on errors
            if (frame._tag === "interrupt-frame" || frame._tag === "environment-frame") {
                frame.exitRegion();
            }
            frame = frameStack.pop();
        }
        // At the end... so we have failed
        result.complete(e as Cause<E>);
        return;
    }


    function resumeInterrupt(): void {
        runtime.dispatch(() => {
            const go = handle(interruptExit);
            if (go) {
                // eslint-disable-next-line
                loop(go);
            }
        });
    }

    function next(value: unknown): UnkIO | undefined {
        const frame = frameStack.pop();
        if (frame) {
            return frame.apply(value);
        }
        result.complete(done(value) as Done<A>);
        return;
    }

    function resume(status: Either<unknown, unknown>): void {
        cancelAsync = undefined;
        runtime.dispatch(() => {
            foldEither(
                (cause: unknown) => {
                    const go = handle(raise(cause));
                    if (go) {
                        /* eslint-disable-next-line */
                        loop(go);
                    }
                },
                (value: unknown) => {
                    const go = next(value);
                    if (go) {
                        /* eslint-disable-next-line */
                        loop(go);
                    }
                }
            )(status);
        });
    }

    function contextSwitch(op: FunctionN<[FunctionN<[Either<unknown, unknown>], void>], Lazy<void>>): void {
        let complete = false;
        const wrappedCancel = op((status) => {
            if (complete) {
                return;
            }
            complete = true;
            resume(status);
        });
        cancelAsync = () => {
            complete = true;
            wrappedCancel();
        };
    }

    function loop(go: UnkIO): void {
        let current: UnkIO | undefined = go;
        while (current && (!isInterruptible() || !interrupted)) {
            try {
                if (current._tag === "pure") {
                    current = next(current.value);
                } else if (current._tag === "raised") {
                    if (current.error._tag === "interrupt") {
                        interrupted = true;
                    }
                    current = handle(current.error);
                } else if (current._tag === "completed") {
                    if (current.exit._tag === "value") {
                        current = next(current.exit.value);
                    } else {
                        current = handle(current.exit);
                    }
                } else if (current._tag === "suspended") {
                    current = current.thunk();
                } else if (current._tag === "async") {
                    contextSwitch(current.op);
                    current = undefined;
                } else if (current._tag === "chain") {
                    frameStack.push(makeFrame(current.bind));
                    current = current.inner;
                } else if (current._tag === "collapse") {
                    frameStack.push(makeFoldFrame(current.success, current.failure));
                    current = current.inner;
                } else if (current._tag === "read") {
                    current = io.pure(environmentStack.peek())
                } else if (current._tag === "provide") {
                    environmentStack.push(current.r)
                    frameStack.push(makeEnvironmentFrame(environmentStack));
                    current = current.inner;
                } else if (current._tag === "interrupt-region") {
                    interruptRegionStack.push(current.flag);
                    frameStack.push(makeInterruptFrame(interruptRegionStack));
                    current = current.inner;
                } else if (current._tag === "access-runtime") {
                    current = io.pure(runtime);
                } else if (current._tag === "access-interruptible") {
                    current = io.pure(isInterruptible());
                } else {
                    // This should never happen.
                    // However, there is not great way of ensuring the above is total and its worth having during developments
                    throw new Error(`Die: Unrecognized current type ${current}`);
                }
            } catch (e) {
                current = io.raiseAbort(e);
            }
        }
        // If !current then the interrupt came to late and we completed everything
        if (interrupted && current) {
            resumeInterrupt();
        }
    }

    function start(r: R, run: RIO<R, E, A>): void {
        if (started) {
            throw new Error("Bug: Runtime may not be started multiple times");
        }
        started = true;
        environmentStack.push(r);
        runtime.dispatch(() => loop(run));
    }

    function interrupt(): void {
        if (interrupted) {
            return;
        }
        interrupted = true;
        if (cancelAsync && isInterruptible()) {
            cancelAsync();
            resumeInterrupt();
        }
    }

    

    return {
        start,
        interrupt,
        onExit,
        exit
    };
}
